import { Config, Live2DSprite } from 'easy-live2d'
import { Application, Ticker } from 'pixi.js'

type OverlayAction = 'LEFT' | 'RIGHT' | 'BOTH'
type OverlayIntensity = 'light' | 'normal' | 'strong'

interface OverlayBeatEvent {
  type: 'beat'
  action: OverlayAction
  intensity: OverlayIntensity
  score: number
  levelDb: number
  timestamp: number
}

interface OverlayMeterEvent {
  type: 'meter'
  inputName: string
  levelDb: number
  normalizedLevel: number
  timestamp: number
}

interface OverlayHelloEvent {
  type: 'hello'
  protocol: number
}

type OverlayEvent = OverlayBeatEvent | OverlayMeterEvent | OverlayHelloEvent

const MODEL_PATH = '/models/keyboard/cat.model3.json'
const LEFT_KEY_PATH = '/models/keyboard/resources/left-keys/KeyF.png'
const RIGHT_KEY_PATH = '/models/keyboard/resources/right-keys/LeftArrow.png'
const DEFAULT_EVENTS_URL = 'http://127.0.0.1:45123/events'

const appElement = document.getElementById('app')
const canvasElement = document.getElementById('live2dCanvas')
const keyLayerElement = document.getElementById('keys')
const statusElement = document.getElementById('status')

if (!appElement || !(canvasElement instanceof HTMLCanvasElement) || !keyLayerElement || !statusElement) {
  throw new Error('BongoCat 叠加层缺少必要的页面元素')
}

const canvas = canvasElement
const keyLayer = keyLayerElement

const query = new URLSearchParams(window.location.search)
const debug = query.get('debug') === '1'
const eventsUrl = query.get('events') || DEFAULT_EVENTS_URL

if (debug) document.body.classList.add('debug')

let sprite: Live2DSprite | undefined
let ready = false
let eventSource: EventSource | undefined
let demoTimer: number | undefined
const pendingActions: Array<{ action: OverlayAction, holdMs: number }> = []

const activeLayers: Record<'left' | 'right', HTMLImageElement | undefined> = {
  left: undefined,
  right: undefined,
}
const releaseTimers: Record<'left' | 'right', number | undefined> = {
  left: undefined,
  right: undefined,
}

function setStatus(message: string) {
  statusElement!.textContent = message
}

function updateModelSize() {
  if (!sprite) return

  const modelSize = sprite.getModelCanvasSize()
  if (!modelSize || modelSize.width <= 0 || modelSize.height <= 0) return

  const scale = Math.min(
    window.innerWidth / modelSize.width,
    window.innerHeight / modelSize.height,
  )

  sprite.scale.set(scale)
  sprite.x = window.innerWidth / 2
  sprite.y = window.innerHeight / 2
  sprite.anchor.set(0.5)
}

function releaseSide(side: 'left' | 'right') {
  const layer = activeLayers[side]
  if (layer) layer.remove()
  activeLayers[side] = undefined

  const timer = releaseTimers[side]
  if (timer !== undefined) window.clearTimeout(timer)
  releaseTimers[side] = undefined

  sprite?.setParameterValueById(side === 'left' ? 'CatParamLeftHandDown' : 'CatParamRightHandDown', 0)
}

function pressSide(side: 'left' | 'right', holdMs: number) {
  if (!sprite || !ready) return

  releaseSide(side)

  const layer = document.createElement('img')
  layer.className = 'key-layer'
  layer.alt = ''
  layer.src = side === 'left' ? LEFT_KEY_PATH : RIGHT_KEY_PATH
  keyLayer.appendChild(layer)
  activeLayers[side] = layer

  sprite.setParameterValueById(side === 'left' ? 'CatParamLeftHandDown' : 'CatParamRightHandDown', 1)
  releaseTimers[side] = window.setTimeout(() => releaseSide(side), holdMs)
}

function triggerAction(action: OverlayAction, holdMs: number) {
  if (!ready) {
    pendingActions.push({ action, holdMs })
    if (pendingActions.length > 12) pendingActions.shift()
    return
  }

  if (action === 'LEFT' || action === 'BOTH') pressSide('left', holdMs)
  if (action === 'RIGHT' || action === 'BOTH') pressSide('right', holdMs)
}

function handleEvent(event: OverlayEvent) {
  if (event.type === 'hello') {
    setStatus('已连接 OBS 音乐桥')
    return
  }

  if (event.type === 'meter') {
    if (debug) setStatus(`OBS ${event.inputName || '音频'}：${event.levelDb.toFixed(1)} dB`)
    return
  }

  const holdMs = event.intensity === 'strong' ? 170 : event.intensity === 'normal' ? 125 : 90
  triggerAction(event.action, holdMs)
  if (debug) setStatus(`节拍 ${event.intensity} · ${event.levelDb.toFixed(1)} dB`)
}

function connectEvents() {
  eventSource?.close()
  eventSource = new EventSource(eventsUrl)
  eventSource.onopen = () => setStatus('已连接 OBS 音乐桥')
  eventSource.onerror = () => setStatus('等待 OBS 音乐桥…')
  eventSource.onmessage = (message) => {
    try {
      handleEvent(JSON.parse(message.data) as OverlayEvent)
    } catch {
      // Ignore malformed frames and let EventSource reconnect normally.
    }
  }
}

function startDemo() {
  let index = 0
  demoTimer = window.setInterval(() => {
    const action: OverlayAction = index % 4 === 3 ? 'BOTH' : index % 2 === 0 ? 'LEFT' : 'RIGHT'
    triggerAction(action, action === 'BOTH' ? 170 : 125)
    index += 1
  }, 700)
}

async function startOverlay() {
  Config.MouseFollow = false
  Config.MotionSound = false

  const pixi = new Application()
  await pixi.init({
    backgroundAlpha: 0,
    canvas,
    autoDensity: true,
    resolution: Math.max(window.devicePixelRatio || 1, 1),
    resizeTo: window,
  })

  sprite = new Live2DSprite({
    modelPath: MODEL_PATH,
    ticker: Ticker.shared,
  })
  pixi.stage.addChild(sprite)
  await sprite.ready

  ready = true
  updateModelSize()
  window.addEventListener('resize', updateModelSize)

  for (const pending of pendingActions.splice(0)) {
    triggerAction(pending.action, pending.holdMs)
  }

  connectEvents()
  if (query.get('demo') === '1') startDemo()
}

void startOverlay().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  setStatus(`叠加层加载失败：${message}`)
  document.body.classList.add('debug')
})

window.addEventListener('unload', () => {
  eventSource?.close()
  if (demoTimer !== undefined) window.clearInterval(demoTimer)
  releaseSide('left')
  releaseSide('right')
})

// A tiny debug hook makes it possible to validate the transparent Browser
// Source without touching the user's keyboard or foreground application.
;(globalThis as typeof globalThis & { __bongoOverlay?: { trigger: (action: OverlayAction) => void } }).__bongoOverlay = {
  trigger: action => triggerAction(action, action === 'BOTH' ? 170 : 125),
}
