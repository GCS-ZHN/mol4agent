/**
 * MCP App client for the ChatGPT/Codex plugin.
 *
 * The app connects to the host over the MCP Apps bridge, reads structure bytes
 * from the server's resource, renders through core's Mol* official UI, and
 * long-polls for scene revisions and capture requests.
 *
 * @module @gcszhn/mol4agent-chatgpt/client
 */
import { App, PostMessageTransport } from '@modelcontextprotocol/ext-apps'
import { createMolViewer, type MolViewer } from '@gcszhn/mol4agent-core'
import type { MolFormat } from '@gcszhn/mol4agent-core/protocol'
import type { SceneSnapshot } from '../scene.ts'
import type { PendingCapture } from '../capture.ts'

interface PollResult {
  readonly scene: SceneSnapshot | null
  readonly capture: PendingCapture | null
  readonly timedOut: boolean
}

const app = new App(
  { name: 'mol4agent', version: '0.1.0' },
  {},
  { autoResize: true },
)

const stage = document.getElementById('stage') as HTMLDivElement
const viewerHost = document.getElementById('viewer') as HTMLDivElement
const overlay = document.getElementById('overlay') as HTMLDivElement
const status = document.getElementById('status') as HTMLDivElement
const label = document.getElementById('label') as HTMLSpanElement
const meta = document.getElementById('meta') as HTMLSpanElement
const toastElement = document.getElementById('toast') as HTMLDivElement
const expand = document.getElementById('expand') as HTMLButtonElement

let viewer: MolViewer | null = null
let theme: 'light' | 'dark' = 'dark'
let loadedSceneId: string | null = null
let appliedCommands = 0
let currentSceneId = ''
let currentRevision = -1
let disposed = false
let queue: Promise<void> = Promise.resolve()
let toastTimer: ReturnType<typeof setTimeout> | undefined

const resizeObserver = new ResizeObserver(() => {
  viewer?.resize()
})
resizeObserver.observe(stage)

app.addEventListener('toolresult', params => {
  const structured = params.structuredContent as { scene?: SceneSnapshot } | undefined
  if (structured?.scene !== undefined) {
    const scene = structured.scene
    void enqueue(() => applyScene(scene))
  }
})

app.addEventListener('hostcontextchanged', context => {
  applyHostContext(context)
})

app.addEventListener('toolcancelled', params => {
  if (params.reason !== undefined) showStatus('The tool call was cancelled.', 'error')
})

expand.addEventListener('click', () => {
  const current = document.documentElement.dataset.display ?? 'inline'
  const mode = current === 'fullscreen' ? 'inline' : 'fullscreen'
  void app.requestDisplayMode({ mode }).then(result => {
    setDisplayMode(result.mode)
  }).catch(() => {
    expand.hidden = true
  })
})

void main()

async function main(): Promise<void> {
  try {
    await app.connect(new PostMessageTransport(window.parent, window.parent))
  } catch (reason) {
    showStatus(`Could not connect to the host viewer bridge.\n${messageOf(reason)}`, 'error')
    return
  }
  applyHostContext(app.getHostContext())
  setHostHints()
  void pollLoop()
}

function setHostHints(): void {
  const context = app.getHostContext()
  const modes = context?.availableDisplayModes
  expand.hidden = modes === undefined || !modes.includes('fullscreen')
  if (app.getHostCapabilities()?.serverTools === undefined) {
    meta.textContent = 'limited host: live updates unavailable'
  }
}

function applyHostContext(context: ReturnType<App['getHostContext']>): void {
  const nextTheme = context?.theme === 'light' ? 'light' : 'dark'
  if (nextTheme !== theme) {
    theme = nextTheme
    viewer?.setTheme(theme)
  }
  document.documentElement.dataset.theme = theme
  if (context?.displayMode !== undefined) setDisplayMode(context.displayMode)
  const dimensions = context?.containerDimensions
  if (dimensions !== undefined) {
    const maxHeight = 'height' in dimensions ? dimensions.height : dimensions.maxHeight
    if (typeof maxHeight === 'number' && maxHeight > 0) {
      document.documentElement.style.setProperty('--mol-viewer-height', `${Math.round(Math.min(maxHeight, 900))}px`)
    }
  }
}

function setDisplayMode(mode: 'inline' | 'fullscreen' | 'pip'): void {
  document.documentElement.dataset.display = mode
  expand.textContent = mode === 'fullscreen' ? 'Exit' : 'Expand'
  requestAnimationFrame(() => viewer?.resize())
}

async function pollLoop(): Promise<void> {
  while (!disposed) {
    try {
      const result = await app.callServerTool({
        name: 'mol_viewer_poll',
        arguments: {
          sceneId: currentSceneId,
          revision: currentRevision,
          timeoutMs: 20_000,
        },
      })
      if (result.isError === true) {
        await sleep(1200)
        continue
      }
      const poll = result.structuredContent as unknown as PollResult | undefined
      if (poll?.scene !== null && poll?.scene !== undefined) {
        const scene = poll.scene
        await enqueue(() => applyScene(scene))
      }
      if (poll?.capture !== null && poll?.capture !== undefined) {
        const capture = poll.capture
        await enqueue(() => deliverCapture(capture))
      }
    } catch (reason) {
      if (disposed) return
      meta.textContent = 'reconnecting to mol4agent…'
      await sleep(1500)
      if (app.getHostCapabilities()?.serverTools === undefined) {
        showStatus(
          'This host does not allow the viewer to call back into mol4agent, so live updates and '
          + 'screenshots are unavailable.',
          'error',
        )
        return
      }
    }
  }
}

function enqueue(task: () => Promise<void>): Promise<void> {
  queue = queue.then(task).catch(reason => {
    console.warn('[mol4agent]', reason)
  })
  return queue
}

async function applyScene(scene: SceneSnapshot): Promise<void> {
  if (scene.sceneId === currentSceneId && scene.revision < currentRevision) return
  const currentViewer = await ensureViewer()
  if (scene.sceneId !== loadedSceneId) {
    showStatus(`Loading ${scene.label}…`)
    const resource = await app.readServerResource({ uri: `mol4agent://structure/${scene.sceneId}` })
    const data = decodeStructure(resource)
    await currentViewer.load({ data, format: scene.format, label: scene.label })
    loadedSceneId = scene.sceneId
    appliedCommands = 0
  }
  if (scene.commands.length < appliedCommands) appliedCommands = 0
  const commands = scene.commands.slice(appliedCommands)
  if (commands.length > 0) {
    const results = await currentViewer.apply(commands)
    for (const result of results) {
      if (!result.ok) console.warn('[mol4agent]', result.message)
    }
    appliedCommands = scene.commands.length
  }
  currentSceneId = scene.sceneId
  currentRevision = scene.revision
  label.textContent = scene.label
  meta.textContent = `${scene.format} · revision ${scene.revision}`
  hideStatus()
}

async function deliverCapture(capture: PendingCapture): Promise<void> {
  try {
    await applyScene(capture.scene)
    const currentViewer = await ensureViewer()
    // Headless hosts can throttle requestAnimationFrame. A short timer is
    // enough for Mol* to finish the pending render before the readback.
    await sleep(80)
    const png = await currentViewer.capture({
      width: capture.width,
      height: capture.height,
      transparent: capture.transparent,
    })
    await app.callServerTool({
      name: 'mol_capture_deliver',
      arguments: {
        captureId: capture.captureId,
        data: bytesToBase64(png),
        width: capture.width,
        height: capture.height,
        diagnostics: currentViewer.diagnostics() as unknown as Record<string, unknown>,
      },
    })
    showToast('Screenshot sent')
  } catch (reason) {
    const message = messageOf(reason)
    showStatus(`Could not capture the viewer.\n${message}`, 'error')
    await app.callServerTool({
      name: 'mol_capture_fail',
      arguments: { captureId: capture.captureId, message },
    }).catch(() => {})
  }
}

async function ensureViewer(): Promise<MolViewer> {
  if (viewer !== null) return viewer
  showStatus('Starting Mol*…')
  viewer = await createMolViewer({
    container: viewerHost,
    theme,
    onError: reason => console.error('[mol4agent]', reason),
  })
  return viewer
}

function decodeStructure(result: {
  readonly contents: readonly { readonly text?: string; readonly blob?: string }[]
}): string | Uint8Array {
  const content = result.contents[0]
  if (content === undefined) throw new Error('the structure resource was empty')
  if (typeof content.text === 'string') return content.text
  if (typeof content.blob === 'string') return base64ToBytes(content.blob)
  throw new Error('the structure resource had no text or blob content')
}

function showStatus(text: string, kind?: 'error'): void {
  overlay.hidden = false
  status.className = kind === 'error' ? 'error' : ''
  status.textContent = text
}

function hideStatus(): void {
  overlay.hidden = true
}

function showToast(text: string): void {
  toastElement.textContent = text
  toastElement.classList.add('show')
  if (toastTimer !== undefined) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toastElement.classList.remove('show')
  }, 2200)
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 0x8000
  let binary = ''
  for (let index = 0; index < bytes.length; index += chunk) {
    const slice = bytes.subarray(index, Math.min(index + chunk, bytes.length))
    binary += String.fromCharCode(...slice)
  }
  return btoa(binary)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

export type { MolFormat }
