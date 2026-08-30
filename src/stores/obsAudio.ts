import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'

export type ObsAudioConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface ObsAudioSettings {
  enabled: boolean
  host: string
  port: number
  password: string
  inputName: string
  sensitivity: number
  minIntervalMs: number
  strongThreshold: number
  silenceThreshold: number
}

export interface ObsAudioInput {
  inputName: string
  inputUuid?: string
  inputKind?: string
}

export const DEFAULT_OBS_AUDIO_SETTINGS: Readonly<ObsAudioSettings> = Object.freeze({
  enabled: false,
  host: '127.0.0.1',
  port: 4455,
  password: '',
  inputName: '',
  sensitivity: 1,
  minIntervalMs: 120,
  strongThreshold: 2.1,
  // OBS' magnitude meter can sit well below -55 dB for a quiet music source.
  // Keep the detector gate low and let its adaptive baseline reject noise.
  silenceThreshold: -80,
})

export const useObsAudioStore = defineStore('obsAudio', () => {
  const settings = reactive<ObsAudioSettings>({ ...DEFAULT_OBS_AUDIO_SETTINGS })

  const status = ref<ObsAudioConnectionStatus>('disconnected')
  const statusMessage = ref('')
  const inputs = ref<ObsAudioInput[]>([])
  const levelDb = ref(-100)
  const normalizedLevel = ref(0)
  const lastBeatAt = ref(0)
  const lastBeatIntensity = ref<'light' | 'normal' | 'strong'>()
  const resetSettings = () => Object.assign(settings, DEFAULT_OBS_AUDIO_SETTINGS)

  return {
    settings,
    status,
    statusMessage,
    inputs,
    levelDb,
    normalizedLevel,
    lastBeatAt,
    lastBeatIntensity,
    resetSettings,
  }
}, {
  tauri: {
    filterKeys: [
      'status',
      'statusMessage',
      'inputs',
      'levelDb',
      'normalizedLevel',
      'lastBeatAt',
      'lastBeatIntensity',
    ],
  },
})
