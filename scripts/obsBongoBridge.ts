import type { IncomingMessage, ServerResponse } from 'node:http'

import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import OBSWebSocket, { EventSubscription } from 'obs-websocket-js/json'

import {
  getLevelDbFromMeters,
  RhythmDetector,
} from '../src/services/rhythmDetector'

interface BridgeConfig {
  host: string
  port: number
  inputName?: string
  password?: string
  guiPassword: boolean
  dryRun: boolean
  overlayPort: number
  overlayUrl: string
  addSource: boolean
  sensitivity?: number
  minIntervalMs?: number
  strongThreshold?: number
  silenceThresholdDb?: number
}

interface ObsInput {
  inputName?: unknown
  inputUuid?: unknown
  inputKind?: unknown
}

interface ObsVolumeInput extends ObsInput {
  inputLevelsMul?: unknown
}

interface ObsVolumeEvent {
  inputs?: unknown
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PROJECT_DIR = resolve(SCRIPT_DIR, '..')
const DEFAULT_OVERLAY_PORT = 45123
const DEFAULT_OVERLAY_URL = 'http://127.0.0.1:1420/obs-overlay.html'
const DEFAULT_BROWSER_SOURCE_NAME = 'BongoCat 音乐宠物'

function printHelp() {
  console.log(`
BongoCat OBS 音频桥

用法：
  pnpm bridge:obs
  pnpm bridge:obs -- --input "桌面音频"
  pnpm bridge:obs -- --dry-run
  pnpm bridge:obs -- --gui-password
  pnpm bridge:obs -- --add-source --gui-password

选项：
  --host <地址>       OBS 地址，默认 127.0.0.1
  --port <端口>       OBS WebSocket 端口，默认 4455
  --input <名称>      指定 OBS 音频源名称；不指定时优先选择桌面音频
  --gui-password       使用本机密码对话框输入 OBS 密码
  --overlay-port <端口> 本地叠加层事件端口，默认 45123
  --overlay-url <地址> OBS Browser Source 地址，默认 http://127.0.0.1:1420/obs-overlay.html
  --add-source         自动把叠加层加入当前 OBS 场景
  --dry-run            只识别节拍，不驱动叠加层
  --help              显示此帮助

密码：
  优先读取环境变量 OBS_WEBSOCKET_PASSWORD；没有时会在本机终端隐藏输入。
  非交互启动或指定 --gui-password 时，会弹出本机密码对话框。
  密码不会打印，也不会写入配置文件。
`)
}

function parseArgs(argv: string[]): BridgeConfig | 'help' {
  const config: BridgeConfig = {
    host: '127.0.0.1',
    port: 4455,
    guiPassword: false,
    dryRun: false,
    overlayPort: DEFAULT_OVERLAY_PORT,
    overlayUrl: DEFAULT_OVERLAY_URL,
    addSource: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === '--help' || arg === '-h') return 'help'
    if (arg === '--dry-run') {
      config.dryRun = true
      continue
    }
    if (arg === '--gui-password') {
      config.guiPassword = true
      continue
    }
    if (arg === '--add-source') {
      config.addSource = true
      continue
    }

    if (arg === '--host' || arg === '--port' || arg === '--input' || arg === '--overlay-port' || arg === '--overlay-url') {
      const value = argv[index + 1]
      if (!value) throw new Error(`${arg} 缺少参数`)

      if (arg === '--host') config.host = value
      if (arg === '--port') {
        const port = Number(value)
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error(`端口无效：${value}`)
        }
        config.port = port
      }
      if (arg === '--input') config.inputName = value
      if (arg === '--overlay-port') {
        const port = Number(value)
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error(`叠加层端口无效：${value}`)
        }
        config.overlayPort = port
      }
      if (arg === '--overlay-url') config.overlayUrl = value
      index += 1
      continue
    }

    throw new Error(`未知参数：${arg}`)
  }

  return config
}

async function readSecret(prompt: string) {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new Error('当前终端不能隐藏输入密码，请设置 OBS_WEBSOCKET_PASSWORD 后再启动')
  }

  return await new Promise<string>((resolveSecret, rejectSecret) => {
    const stdin = process.stdin
    let value = ''
    let finished = false

    const cleanup = () => {
      stdin.off('data', onData)
      stdin.setRawMode?.(false)
      stdin.pause()
    }

    const finish = (error?: Error) => {
      if (finished) return
      finished = true
      cleanup()
      process.stdout.write('\n')
      if (error) rejectSecret(error)
      else resolveSecret(value)
    }

    const onData = (chunk: Buffer | string) => {
      for (const char of String(chunk)) {
        if (char === '\u0003') {
          finish(new Error('已取消'))
          return
        }
        if (char === '\r' || char === '\n') {
          finish()
          return
        }
        if (char === '\u007F' || char === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1)
            process.stdout.write('\b \b')
          }
          continue
        }
        value += char
        process.stdout.write('*')
      }
    }

    process.stdout.write(prompt)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on('data', onData)
  })
}

async function readSecretFromGui() {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$form = New-Object System.Windows.Forms.Form
$form.Text = 'OBS WebSocket Password'
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.Width = 430
$form.Height = 155
$label = New-Object System.Windows.Forms.Label
$label.Text = 'Enter the OBS WebSocket password:'
$label.AutoSize = $true
$label.Location = New-Object System.Drawing.Point(18, 16)
$box = New-Object System.Windows.Forms.TextBox
$box.UseSystemPasswordChar = $true
$box.Width = 385
$box.Location = New-Object System.Drawing.Point(18, 43)
$ok = New-Object System.Windows.Forms.Button
$ok.Text = 'OK'
$ok.Width = 80
$ok.Location = New-Object System.Drawing.Point(235, 78)
$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = 'Cancel'
$cancel.Width = 80
$cancel.Location = New-Object System.Drawing.Point(323, 78)
$cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.AcceptButton = $ok
$form.CancelButton = $cancel
$form.Controls.AddRange(@($label, $box, $ok, $cancel))
$result = $form.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($box.Text)
}
`

  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const child = spawn(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-STA', '-EncodedCommand', encoded],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )

  let output = ''
  let errorOutput = ''
  child.stdout.on('data', (data) => {
    output += String(data)
  })
  child.stderr.on('data', (data) => {
    errorOutput += String(data)
  })

  const exitCode = await new Promise<number | null>((resolveExit) => {
    child.once('close', resolveExit)
  })

  if (exitCode !== 0) {
    throw new Error(errorOutput.trim() || '密码对话框未能启动')
  }

  return output.trim()
}

function asInput(value: unknown): ObsInput | undefined {
  if (!value || typeof value !== 'object') return

  const input = value as Record<string, unknown>
  const inputName = typeof input.inputName === 'string' ? input.inputName : ''

  return inputName
    ? {
        inputName,
        inputUuid: typeof input.inputUuid === 'string' ? input.inputUuid : undefined,
        inputKind: typeof input.inputKind === 'string' ? input.inputKind : undefined,
      }
    : undefined
}

function chooseInput(inputs: ObsInput[], requestedName?: string) {
  if (requestedName) {
    const exact = inputs.find(input => input.inputName === requestedName)
    if (!exact) {
      const available = inputs.map(input => input.inputName).filter(Boolean).join('、') || '（无）'
      throw new Error(`找不到 OBS 音频源“${requestedName}”。当前可用源：${available}`)
    }
    return exact.inputName as string
  }

  const preferred = inputs.find((input) => {
    const name = String(input.inputName || '')
    return /桌面音频|desktop\s*audio|music|音乐/i.test(name)
  })

  return (preferred || inputs[0])?.inputName as string | undefined
}

type OverlayAction = 'LEFT' | 'RIGHT' | 'BOTH'

interface OverlayBeatEvent {
  type: 'beat'
  action: OverlayAction
  intensity: 'light' | 'normal' | 'strong'
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

type OverlayEvent = OverlayBeatEvent | OverlayMeterEvent

/**
 * Local-only event stream consumed by the OBS Browser Source.
 *
 * The old implementation injected F/arrow keys into Windows. This server is
 * deliberately loopback-only and carries only beat data, so the active OBS
 * scene, game, editor, and chat window never receive synthetic keyboard input.
 */
class OverlayEventServer {
  private server?: ReturnType<typeof createServer>
  private heartbeat?: ReturnType<typeof setInterval>
  private readonly clients = new Set<ServerResponse>()

  constructor(private readonly port: number) {}

  async start() {
    if (this.server) return

    this.server = createServer((request, response) => {
      this.handleRequest(request, response)
    })

    await new Promise<void>((resolveServer, rejectServer) => {
      const server = this.server!
      const onError = (error: Error) => {
        server.off('listening', onListening)
        rejectServer(error)
      }
      const onListening = () => {
        server.off('error', onError)
        resolveServer()
      }

      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.port, '127.0.0.1')
    })

    this.heartbeat = setInterval(() => {
      this.writeFrame(': heartbeat\n\n')
    }, 15_000)
  }

  publish(event: OverlayEvent) {
    this.writeFrame(`data: ${JSON.stringify(event)}\n\n`)
  }

  async stop() {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = undefined

    for (const client of this.clients) client.end()
    this.clients.clear()

    if (!this.server) return

    const server = this.server
    this.server = undefined

    await new Promise<void>((resolveServer) => {
      server.close(() => resolveServer())
    })
  }

  private handleRequest(request: IncomingMessage, response: ServerResponse) {
    const origin = request.headers.origin || '*'
    response.setHeader('Access-Control-Allow-Origin', origin)
    response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    response.setHeader('Vary', 'Origin')

    if (request.method === 'OPTIONS') {
      response.writeHead(204)
      response.end()
      return
    }

    const pathname = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`).pathname

    if (pathname === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: true, protocol: 1 }))
      return
    }

    if (pathname !== '/events' || request.method !== 'GET') {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('Not found')
      return
    }

    response.writeHead(200, {
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no',
    })
    response.write('retry: 1000\n\n')
    response.write('data: {"type":"hello","protocol":1}\n\n')
    this.clients.add(response)
    request.on('close', () => this.clients.delete(response))
  }

  private writeFrame(frame: string) {
    for (const client of this.clients) {
      if (client.writableEnded || client.destroyed) {
        this.clients.delete(client)
        continue
      }

      client.write(frame)
    }
  }
}

class OverlayWebServer {
  private child?: ReturnType<typeof spawn>
  private startedByBridge = false

  constructor(private readonly url: string) {}

  async ensure() {
    if (await this.isReady()) return

    this.child = spawn(
      process.execPath,
      [resolve(PROJECT_DIR, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1'],
      { cwd: PROJECT_DIR, stdio: 'ignore', windowsHide: true },
    )
    this.startedByBridge = true

    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (await this.isReady()) return
      await new Promise(resolveDelay => setTimeout(resolveDelay, 250))
    }

    this.stop()
    throw new Error(`叠加层页面未能启动：${this.url}`)
  }

  stop() {
    if (!this.startedByBridge || !this.child) return

    this.child.kill()
    this.child = undefined
    this.startedByBridge = false
  }

  private async isReady() {
    try {
      const response = await fetch(this.url, { signal: AbortSignal.timeout(500) })
      return response.ok
    } catch {
      return false
    }
  }
}

async function ensureObsBrowserSource(
  obs: OBSWebSocket,
  overlayUrl: string,
  sourceName = DEFAULT_BROWSER_SOURCE_NAME,
) {
  const sceneResponse = await obs.call('GetCurrentProgramScene') as { sceneName?: unknown }
  const sceneName = typeof sceneResponse.sceneName === 'string' ? sceneResponse.sceneName : ''

  if (!sceneName) throw new Error('OBS 当前没有节目场景，无法自动添加 Browser Source')

  const inputSettings = {
    css: 'html,body{margin:0;background:transparent;overflow:hidden;}canvas{display:block;}',
    fps: 60,
    height: 360,
    restart_when_active: true,
    shutdown: false,
    url: overlayUrl,
    width: 640,
  }

  let exists = false
  try {
    await obs.call('GetInputSettings', { inputName: sourceName })
    exists = true
  } catch {
    // The source is created below when it does not exist yet.
  }

  if (exists) {
    await obs.call('SetInputSettings', {
      inputName: sourceName,
      inputSettings,
      overlay: false,
    })
  } else {
    await obs.call('CreateInput', {
      inputKind: 'browser_source',
      inputName: sourceName,
      inputSettings,
      sceneItemEnabled: true,
      sceneName,
    })
  }

  const itemsResponse = await obs.call('GetSceneItemList', { sceneName }) as { sceneItems?: unknown[] }
  const sceneItem = (itemsResponse.sceneItems || []).find((item) => {
    if (!item || typeof item !== 'object') return false
    return (item as Record<string, unknown>).sourceName === sourceName
  }) as Record<string, unknown> | undefined
  const sceneItemId = sceneItem?.sceneItemId

  // Do not overwrite a layout the user has already chosen. The transform is
  // only initialized for a newly-created source.
  if (exists || typeof sceneItemId !== 'number') return { sceneName, sourceName }

  let baseWidth = 1920
  let baseHeight = 1080

  try {
    const video = await obs.call('GetVideoSettings') as Record<string, unknown>
    if (typeof video.baseWidth === 'number') baseWidth = video.baseWidth
    if (typeof video.baseHeight === 'number') baseHeight = video.baseHeight
  } catch {
    // Keep the common 1080p fallback if this OBS build does not expose it.
  }

  const wasLocked = sceneItem.sceneItemLocked === true

  if (wasLocked) {
    await obs.call('SetSceneItemLocked', {
      sceneItemId,
      sceneItemLocked: false,
      sceneName,
    })
  }

  await obs.call('SetSceneItemTransform', {
    sceneItemId,
    sceneItemTransform: {
      alignment: 0,
      positionX: Math.max(0, baseWidth - 660),
      positionY: Math.max(0, baseHeight - 380),
    },
    sceneName,
  })

  if (wasLocked) {
    await obs.call('SetSceneItemLocked', {
      sceneItemId,
      sceneItemLocked: true,
      sceneName,
    })
  }

  return { sceneName, sourceName }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed === 'help') {
    printHelp()
    return
  }

  const config = parsed
  const password = process.env.OBS_WEBSOCKET_PASSWORD !== undefined
    ? process.env.OBS_WEBSOCKET_PASSWORD
    : config.guiPassword || !process.stdin.isTTY
      ? await readSecretFromGui()
      : await readSecret('请输入 OBS WebSocket 密码（不会显示）：')

  if (!password && !config.dryRun) {
    throw new Error('没有输入 OBS WebSocket 密码')
  }
  const obs = new OBSWebSocket()
  const overlay = new OverlayEventServer(config.overlayPort)
  const webServer = new OverlayWebServer(config.overlayUrl)
  const detector = new RhythmDetector({
    sensitivity: config.sensitivity,
    minIntervalMs: config.minIntervalMs,
    strongThreshold: config.strongThreshold,
    silenceThresholdDb: config.silenceThresholdDb,
  })

  let selectedInputName: string | undefined
  let hand: 'left' | 'right' = 'left'
  let beats = 0
  let lastMeterLogAt = 0
  let lastOverlayMeterAt = 0
  let shuttingDown = false

  const shutdown = async (exitCode = 0) => {
    if (shuttingDown) return
    shuttingDown = true
    await overlay.stop()
    webServer.stop()

    if (obs.identified) {
      try {
        await obs.disconnect()
      } catch {
        // The desired shutdown state is already reached.
      }
    }

    if (exitCode !== 0) process.exitCode = exitCode
  }

  process.once('SIGINT', () => {
    void shutdown()
  })
  process.once('SIGTERM', () => {
    void shutdown()
  })

  obs.on('InputVolumeMeters', (event) => {
    if (shuttingDown) return

    const payload = event as unknown as ObsVolumeEvent
    const inputs = Array.isArray(payload.inputs) ? payload.inputs as ObsVolumeInput[] : []
    const selected = selectedInputName
      ? inputs.find(input => input.inputName === selectedInputName)
      : inputs[0]
    const levelDb = getLevelDbFromMeters(selected?.inputLevelsMul)
    const timestamp = Date.now()
    const hit = detector.process(levelDb, timestamp)

    if (timestamp - lastMeterLogAt >= 2000) {
      lastMeterLogAt = timestamp
      console.log(`[音频] ${selectedInputName || '未选择'} ${levelDb.toFixed(1)} dB，节拍 ${beats}`)
    }

    if (timestamp - lastOverlayMeterAt >= 100) {
      lastOverlayMeterAt = timestamp
      overlay.publish({
        type: 'meter',
        inputName: selectedInputName || '',
        levelDb,
        normalizedLevel: Math.max(0, Math.min(1, (levelDb + 55) / 55)),
        timestamp,
      })
    }

    if (!hit) return

    beats += 1
    let action: OverlayAction
    if (hit.intensity === 'strong') {
      action = 'BOTH'
      hand = 'left'
    } else if (hand === 'left') {
      action = 'LEFT'
      hand = 'right'
    } else {
      action = 'RIGHT'
      hand = 'left'
    }

    if (!config.dryRun) {
      overlay.publish({
        type: 'beat',
        action,
        intensity: hit.intensity,
        score: hit.score,
        levelDb: hit.levelDb,
        timestamp: hit.timestamp,
      })
    }

    console.log(`[节拍] #${beats} ${hit.intensity} ${hit.levelDb.toFixed(1)} dB`)
  })

  obs.on('ConnectionClosed', () => {
    if (shuttingDown) return
    console.error('OBS 连接已断开')
    void shutdown(1)
  })

  try {
    await overlay.start()
    await webServer.ensure()
    console.log(`叠加层已就绪：${config.overlayUrl}`)

    const url = `ws://${config.host}:${config.port}`
    console.log(`正在连接 OBS：${url}`)
    await obs.connect(url, password || undefined, {
      eventSubscriptions: EventSubscription.InputVolumeMeters,
    })

    const response = await obs.call('GetInputList') as { inputs?: unknown[] }
    const inputs = (response.inputs || []).map(asInput).filter((value): value is ObsInput => Boolean(value))
    selectedInputName = chooseInput(inputs, config.inputName)

    if (!selectedInputName) {
      throw new Error('OBS 当前没有可用音频源，请先确认“桌面音频”或“麦克风/辅助音频”已启用')
    }

    detector.reset()
    if (config.addSource) {
      const sourceUrl = new URL(config.overlayUrl)
      sourceUrl.searchParams.set('events', `http://127.0.0.1:${config.overlayPort}/events`)
      const { sceneName, sourceName } = await ensureObsBrowserSource(obs, sourceUrl.toString())
      console.log(`已把 Browser Source“${sourceName}”加入 OBS 场景“${sceneName}”`)
    }

    console.log(`已连接 OBS，监听音频源：${selectedInputName}`)
    if (config.dryRun) {
      console.log('当前为 dry-run：会识别节拍，但不会驱动叠加层')
    } else {
      console.log('安全模式：只向本机 Browser Source 发送节拍数据，不发送任何系统按键。')
    }
    console.log('桥接器运行中，按 Ctrl+C 停止。')
  } catch (error) {
    console.error(`连接失败：${errorMessage(error)}`)
    await shutdown(1)
  }
}

void main().catch((error) => {
  console.error(errorMessage(error))
  process.exitCode = 1
})
