import { emitTo } from '@tauri-apps/api/event'
import OBSWebSocket, { EventSubscription } from 'obs-websocket-js/json'
import { onMounted, onUnmounted, watch } from 'vue'

import type { RhythmHit } from '@/services/rhythmDetector'
import type { ObsAudioConnectionStatus, ObsAudioInput, ObsAudioSettings } from '@/stores/obsAudio'

import { LISTEN_KEY } from '@/constants'
import {
  getLevelDbFromMeters,
  RhythmDetector,
} from '@/services/rhythmDetector'
import { useModelStore } from '@/stores/model'
import { useObsAudioStore } from '@/stores/obsAudio'

import { useModel } from './useModel'
import { useTauriListen } from './useTauriListen'

interface ObsVolumeInput {
  inputName?: unknown
  inputUuid?: unknown
  inputKind?: unknown
  inputLevelsMul?: unknown
}

interface ObsVolumeEvent {
  inputs: ObsVolumeInput[]
}

interface ObsRuntimeState {
  status: ObsAudioConnectionStatus
  statusMessage: string
  inputs: ObsAudioInput[]
  selectedInputName: string
  levelDb: number
  normalizedLevel: number
  lastBeatAt: number
  lastBeatIntensity?: RhythmHit['intensity']
}

export type ObsAudioTestAction = 'left' | 'right' | 'both'

// The first entries are the keyboard preset's canonical keys. The remaining
// entries keep the test action useful if a user has selected another bundled
// BongoCat model that exposes gamepad-style key slots.
const LEFT_KEY_CANDIDATES = ['KeyF', 'DPadLeft', 'LeftTrigger', 'West'] as const
const RIGHT_KEY_CANDIDATES = ['LeftArrow', 'RightArrow', 'DPadRight', 'RightTrigger', 'East'] as const

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message

  return String(error)
}

function asInput(value: Record<string, unknown>): ObsAudioInput | undefined {
  const inputName = typeof value.inputName === 'string' ? value.inputName : ''

  if (!inputName) return

  return {
    inputName,
    inputUuid: typeof value.inputUuid === 'string' ? value.inputUuid : undefined,
    inputKind: typeof value.inputKind === 'string' ? value.inputKind : undefined,
  }
}

/** Send settings from the preferences webview to the main pet webview. */
export function broadcastObsAudioSettings(settings: ObsAudioSettings) {
  return emitTo('main', LISTEN_KEY.OBS_AUDIO_SETTINGS_CHANGED, { ...settings })
}

/**
 * Preferences and the transparent pet are separate Tauri webviews. This
 * composable mirrors settings/state between them without creating a second
 * OBS connection in the preferences window.
 */
export function useObsAudioSettingsSync() {
  const store = useObsAudioStore()

  const broadcast = () => {
    void broadcastObsAudioSettings(store.settings).catch(() => {
      // The main window may not exist yet; the persisted store will be picked
      // up when it starts.
    })
  }

  watch(() => ({ ...store.settings }), broadcast, { deep: true })

  useTauriListen<ObsRuntimeState>(LISTEN_KEY.OBS_AUDIO_STATE_CHANGED, ({ payload }) => {
    store.status = payload.status
    store.statusMessage = payload.statusMessage
    store.inputs = payload.inputs
    store.levelDb = payload.levelDb
    store.normalizedLevel = payload.normalizedLevel
    store.lastBeatAt = payload.lastBeatAt
    store.lastBeatIntensity = payload.lastBeatIntensity

    if (!store.settings.inputName && payload.selectedInputName) {
      store.settings.inputName = payload.selectedInputName
    }
  })

  onMounted(() => {
    // Allow the state listener to register before asking the main webview for
    // its current snapshot.
    window.setTimeout(() => {
      void emitTo('main', LISTEN_KEY.OBS_AUDIO_STATE_REQUEST).catch(() => {})
    }, 0)
    broadcast()
  })
}

export function useObsAudio() {
  const store = useObsAudioStore()
  const modelStore = useModelStore()
  const { handlePress, handleRelease } = useModel()
  const detector = new RhythmDetector()
  const obs = new OBSWebSocket()
  const releaseTimers = new Map<string, ReturnType<typeof setTimeout>>()

  let shouldRun = false
  let connectionAttempt: Promise<void> | undefined
  let connectionGeneration = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let destroyed = false
  let nextHand: 'left' | 'right' = 'left'
  let nextRightKey = 0
  let lastRuntimeBroadcast = 0

  const publishRuntime = (force = false) => {
    const now = Date.now()

    if (!force && now - lastRuntimeBroadcast < 100) return

    lastRuntimeBroadcast = now

    const state: ObsRuntimeState = {
      status: store.status,
      statusMessage: store.statusMessage,
      inputs: store.inputs,
      selectedInputName: store.settings.inputName,
      levelDb: store.levelDb,
      normalizedLevel: store.normalizedLevel,
      lastBeatAt: store.lastBeatAt,
      lastBeatIntensity: store.lastBeatIntensity,
    }

    void emitTo('preference', LISTEN_KEY.OBS_AUDIO_STATE_CHANGED, state).catch(() => {})
  }

  const setStatus = (status: ObsAudioConnectionStatus, message = '', force = true) => {
    store.status = status
    store.statusMessage = message
    publishRuntime(force)
  }

  const clearReconnect = () => {
    if (!reconnectTimer) return

    clearTimeout(reconnectTimer)
    reconnectTimer = undefined
  }

  const scheduleReconnect = () => {
    if (!shouldRun || destroyed || reconnectTimer) return

    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      void connect()
    }, 3000)
  }

  const releaseKeyLater = (key: string, durationMs: number) => {
    const previous = releaseTimers.get(key)

    if (previous) clearTimeout(previous)

    handlePress(key)

    const timer = setTimeout(() => {
      handleRelease(key)
      releaseTimers.delete(key)
    }, durationMs)

    releaseTimers.set(key, timer)
  }

  const releaseAllMusicKeys = () => {
    for (const [key, timer] of releaseTimers) {
      clearTimeout(timer)
      handleRelease(key)
    }

    releaseTimers.clear()
  }

  const releaseAllModelKeys = () => {
    for (const key of Object.keys(modelStore.pressedKeys)) {
      handleRelease(key)
    }
  }

  const resetRuntimeLevel = () => {
    store.levelDb = -100
    store.normalizedLevel = 0
    store.lastBeatAt = 0
    store.lastBeatIntensity = undefined
  }

  const getLeftKey = () => LEFT_KEY_CANDIDATES.find(key => modelStore.supportKeys[key])

  const getRightKey = () => {
    const rightKeys = RIGHT_KEY_CANDIDATES.filter(key => modelStore.supportKeys[key])

    return rightKeys.length > 0 ? rightKeys[nextRightKey % rightKeys.length] : undefined
  }

  const triggerHit = (hit: RhythmHit) => {
    const duration = hit.intensity === 'strong' ? 145 : hit.intensity === 'normal' ? 110 : 80
    const leftKey = getLeftKey()
    const rightKey = getRightKey()

    if (hit.intensity === 'strong') {
      if (leftKey) releaseKeyLater(leftKey, duration)
      if (rightKey) releaseKeyLater(rightKey, duration)
      nextRightKey += 1
      nextHand = 'left'
      return
    }

    if (nextHand === 'left' && leftKey) {
      releaseKeyLater(leftKey, duration)
      nextHand = 'right'
      return
    }

    if (rightKey) {
      releaseKeyLater(rightKey, duration)
      nextRightKey += 1
      nextHand = 'left'
      return
    }

    if (leftKey) {
      releaseKeyLater(leftKey, duration)
      nextHand = 'right'
    }
  }

  const triggerTestAction = (action: ObsAudioTestAction) => {
    const timestamp = Date.now()
    const hit: RhythmHit = {
      intensity: action === 'both' ? 'strong' : 'normal',
      score: 1,
      levelDb: store.levelDb,
      timestamp,
    }

    if (action === 'both') {
      triggerHit(hit)
      return
    }

    const key = action === 'left' ? getLeftKey() : getRightKey()

    if (!key) return

    releaseKeyLater(key, 120)

    if (action === 'right') nextRightKey += 1
  }

  const handleVolumeMeters = (event: ObsVolumeEvent) => {
    if (!shouldRun || !store.settings.enabled) return

    const inputs = Array.isArray(event.inputs) ? event.inputs : []
    const selectedName = store.settings.inputName
    const input = selectedName
      ? inputs.find(item => item.inputName === selectedName)
      : inputs[0]

    if (!selectedName && typeof input?.inputName === 'string') {
      // A fresh installation has no source preference yet. Pick the first
      // active OBS audio input, which is more reliable than guessing from the
      // complete (mixed audio/video) input list.
      store.settings.inputName = input.inputName
      publishRuntime(true)
    }

    const timestamp = Date.now()
    const levelDb = getLevelDbFromMeters(input?.inputLevelsMul)
    const sample = detector.getSample(levelDb, timestamp)

    store.levelDb = sample.levelDb
    store.normalizedLevel = sample.normalizedLevel

    const hit = detector.processSample(sample, timestamp)

    if (hit) {
      store.lastBeatAt = hit.timestamp
      store.lastBeatIntensity = hit.intensity
      triggerHit(hit)
      publishRuntime(true)
    } else {
      publishRuntime()
    }
  }

  const connect = () => {
    if (!shouldRun || destroyed || obs.identified) return Promise.resolve()
    if (connectionAttempt) return connectionAttempt

    const generation = ++connectionGeneration
    setStatus('connecting', '正在连接 OBS…')

    const attempt = (async () => {
      try {
        const { host, port, password } = store.settings
        const url = `ws://${host || '127.0.0.1'}:${port || 4455}`

        await obs.connect(url, password || undefined, {
          eventSubscriptions: EventSubscription.InputVolumeMeters,
        })

        // A toggle or address edit may have invalidated this attempt while
        // the websocket handshake was in flight.
        if (generation !== connectionGeneration || !shouldRun || destroyed || !store.settings.enabled) {
          if (obs.identified) await obs.disconnect()
          return
        }

        const response = await obs.call('GetInputList') as { inputs?: unknown[] }
        const inputs = (response.inputs ?? [])
          .filter((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object'))
          .map(asInput)
          .filter((value): value is ObsAudioInput => Boolean(value))

        if (generation !== connectionGeneration || !shouldRun || destroyed || !store.settings.enabled) {
          if (obs.identified) await obs.disconnect()
          return
        }

        store.inputs = inputs
        if (store.settings.inputName && !inputs.some(input => input.inputName === store.settings.inputName)) {
          store.settings.inputName = ''
        }
        detector.reset()

        setStatus('connected', inputs.length > 0 ? '已连接，等待音频…' : '已连接，但没有可用音频源')
        publishRuntime(true)
      } catch (error) {
        if (generation !== connectionGeneration || !shouldRun || destroyed || !store.settings.enabled) return

        const message = errorMessage(error)

        setStatus('error', message)
        scheduleReconnect()
      }
    })()

    connectionAttempt = attempt
    void attempt.then(
      () => {
        if (connectionAttempt === attempt) connectionAttempt = undefined
      },
      () => {
        if (connectionAttempt === attempt) connectionAttempt = undefined
      },
    )

    return attempt
  }

  const disconnect = async () => {
    connectionGeneration += 1
    clearReconnect()
    detector.reset()
    releaseAllMusicKeys()
    resetRuntimeLevel()
    store.inputs = []

    if (obs.identified) {
      try {
        await obs.disconnect()
      } catch {
        // The socket may already have closed; the desired state is still idle.
      }
    }

    // If a handshake is still pending, let it observe the invalidated
    // generation and close itself before reporting the final idle state.
    if (connectionAttempt) await connectionAttempt

    setStatus('disconnected')
  }

  const applySettings = () => {
    detector.updateOptions({
      sensitivity: store.settings.sensitivity,
      minIntervalMs: store.settings.minIntervalMs,
      strongThreshold: store.settings.strongThreshold,
      silenceThresholdDb: store.settings.silenceThreshold,
    })
  }

  obs.on('InputVolumeMeters', (event) => {
    handleVolumeMeters(event as unknown as ObsVolumeEvent)
  })

  obs.on('ConnectionClosed', (error) => {
    if (!shouldRun || destroyed) return

    detector.reset()
    releaseAllMusicKeys()
    resetRuntimeLevel()
    store.inputs = []
    setStatus('disconnected', error?.message || 'OBS 连接已断开')
    scheduleReconnect()
  })

  obs.on('ConnectionError', (error) => {
    if (!shouldRun || destroyed) return

    setStatus('error', error?.message || 'OBS 连接错误')
  })

  useTauriListen<ObsAudioSettings>(LISTEN_KEY.OBS_AUDIO_SETTINGS_CHANGED, ({ payload }) => {
    Object.assign(store.settings, payload)
  })

  useTauriListen<void>(LISTEN_KEY.OBS_AUDIO_STATE_REQUEST, () => {
    publishRuntime(true)
  })

  useTauriListen<ObsAudioTestAction>(LISTEN_KEY.OBS_AUDIO_TEST_ACTION, ({ payload }) => {
    if (payload === 'left' || payload === 'right' || payload === 'both') {
      triggerTestAction(payload)
    }
  })

  watch(() => store.settings.enabled, (value) => {
    shouldRun = value

    if (value) {
      // Do not leave a real keyboard/gamepad press held when ownership moves
      // to the music driver.
      releaseAllModelKeys()
      applySettings()
      void connect()
    } else {
      void disconnect()
    }
  }, { immediate: true })

  watch(() => [
    store.settings.sensitivity,
    store.settings.minIntervalMs,
    store.settings.strongThreshold,
    store.settings.silenceThreshold,
  ], applySettings)

  watch(() => [store.settings.host, store.settings.port, store.settings.password], () => {
    if (!store.settings.enabled) return

    shouldRun = false
    void disconnect().then(() => {
      shouldRun = store.settings.enabled
      void connect()
    })
  })

  watch(() => store.settings.inputName, () => {
    detector.reset()
    releaseAllMusicKeys()
  })

  onMounted(() => {
    destroyed = false
    shouldRun = store.settings.enabled
    applySettings()

    if (shouldRun) void connect()
  })

  onUnmounted(() => {
    destroyed = true
    shouldRun = false
    void disconnect()
  })

  return {
    connect,
    disconnect,
    triggerHit,
    triggerTestAction,
  }
}
