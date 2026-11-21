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
import type { CommandResult, MolFormat } from '@gcszhn/mol4agent-core/protocol'
import type { SceneSnapshot, SceneSource, SceneStructureSnapshot } from '../scene.ts'
import type { PendingCapture } from '../capture.ts'
import { gunzipBytes } from './gzip.ts'
import type { PendingInspect, PendingTmScore } from '../inspect.ts'
import { encodeInspectAnswer, encodeTmScoreAnswer } from './inspect.ts'

interface PollResult {
  readonly scene: SceneSnapshot | null
  readonly capture: PendingCapture | null
  readonly inspect: PendingInspect | null
  readonly tmscore: PendingTmScore | null
  readonly timedOut: boolean
  readonly missing?: boolean
}

const MAX_STRUCTURE_BYTES = 64 * 1024 * 1024

const app = new App(
  { name: 'mol4agent', version: '0.4.1' },
  { availableDisplayModes: ['inline', 'fullscreen'] },
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
let loadedStructureIds: string[] = []
let appliedCommands = 0
let currentSceneId = ''
let currentRevision = -1
let boundSceneId: string | null = null
let appKind: SceneSource | 'unknown' = 'unknown'
let pollMode: SceneSource = 'agent'
let pollStarted = false
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
    if (appKind === 'unknown') appKind = scene.source
    if (appKind === 'file' && scene.source !== 'file') return
    if (appKind === 'agent' && scene.source !== 'agent') return
    if (boundSceneId !== null && scene.sceneId !== boundSceneId) return
    void enqueue(async () => {
      const applied = await applyScene(scene)
      if (applied && !pollStarted) startPoll(appKind === 'file' ? 'file' : 'agent')
    })
  }
})

app.addEventListener('hostcontextchanged', context => {
  applyHostContext(context)
})

app.addEventListener('toolcancelled', params => {
  if (params.reason !== undefined) showStatus('The tool call was cancelled.', 'error')
})

expand.addEventListener('click', () => {
  void app.requestDisplayMode({ mode: 'fullscreen' }).then(result => {
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
  const toolName = app.getHostContext()?.toolInfo?.tool.name
  if (toolName === 'mol_view_file') appKind = 'file'
  else if (toolName === 'mol_open') appKind = 'agent'
  // Only open/file pages may claim the side panel; a capture result belongs to
  // the agent tab that is already mounted.
  if (toolName !== 'mol_capture') void openSidePanel()
}

async function openSidePanel(): Promise<void> {
  const context = app.getHostContext()
  if (context?.displayMode === 'fullscreen') return
  try {
    const result = await app.requestDisplayMode({ mode: 'fullscreen' })
    setDisplayMode(result.mode)
  } catch {
    // The host may require a user gesture; the Expand button remains available.
  }
}

function setHostHints(): void {
  const context = app.getHostContext()
  const modes = context?.availableDisplayModes
  expand.hidden = context?.displayMode === 'fullscreen'
    || (modes !== undefined && !modes.includes('fullscreen'))
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
  // The side-panel tab has its own close button; only offer opening the tab
  // from an inline card. Never show an "Exit" toggle in the tab.
  expand.hidden = mode !== 'inline'
  expand.textContent = 'Expand'
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
          mode: pollMode,
          timeoutMs: 20_000,
        },
      })
      if (result.isError === true) {
        await sleep(1200)
        continue
      }
      const poll = result.structuredContent as unknown as PollResult | undefined
      if (poll?.missing === true) {
        showStatus('This structure tab is no longer available. Reopen the file to continue.', 'error')
        return
      }
      if (poll?.scene !== null && poll?.scene !== undefined) {
        const scene = poll.scene
        await enqueue(async () => { await applyScene(scene) })
      }
      if (poll?.capture !== null && poll?.capture !== undefined) {
        const capture = poll.capture
        await enqueue(() => deliverCapture(capture))
      }
      if (poll?.inspect !== null && poll?.inspect !== undefined) {
        const inspect = poll.inspect
        await enqueue(() => deliverInspect(inspect))
      }
      if (poll?.tmscore !== null && poll?.tmscore !== undefined) {
        const tmscore = poll.tmscore
        await enqueue(() => deliverTmScore(tmscore))
      }
      if (
        poll?.timedOut === true
        && !poll.scene
        && !poll.capture
        && !poll.inspect
        && !poll.tmscore
      ) {
        await sleep(100)
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

function startPoll(mode: SceneSource): void {
  if (pollStarted) return
  pollStarted = true
  pollMode = mode
  void pollLoop()
}

function enqueue(task: () => Promise<void>): Promise<void> {
  queue = queue.then(task).catch(reason => {
    console.warn('[mol4agent]', reason)
  })
  return queue
}

async function applyScene(scene: SceneSnapshot): Promise<boolean> {
  try {
    if (appKind === 'file' && scene.source !== 'file') return false
    if (appKind === 'agent' && scene.source !== 'agent') return false
    if (boundSceneId === null) boundSceneId = scene.sceneId
    else if (scene.sceneId !== boundSceneId) return false
    if (scene.sceneId === currentSceneId && scene.revision < currentRevision) return false
    const currentViewer = await ensureViewer()
    if (scene.sceneId !== loadedSceneId) {
      showStatus(`Loading ${scene.label}…`)
      const primary = primaryStructureOf(scene)
      const data = await readStructure(scene, primary)
      await currentViewer.load(
        { data, format: primary.format, label: primary.label },
        { id: primary.id },
      )
      loadedSceneId = scene.sceneId
      loadedStructureIds = [primary.id]
      appliedCommands = 0
    }
    for (const structure of scene.structures ?? []) {
      if (loadedStructureIds.includes(structure.id)) continue
      const data = await readStructure(scene, structure)
      const entry = await currentViewer.addStructure(
        { data, format: structure.format, label: structure.label },
        { id: structure.id },
      )
      loadedStructureIds = [...loadedStructureIds, entry.id]
    }
    if (scene.commands.length < appliedCommands) appliedCommands = 0
    const commands = scene.commands.slice(appliedCommands)
    if (commands.length > 0) {
      const firstIndex = appliedCommands
      const results = await currentViewer.apply(commands)
      for (let offset = 0; offset < results.length; offset += 1) {
        const result = results[offset]
        if (result === undefined) continue
        if (!result.ok) console.warn('[mol4agent]', result.message)
        if (commands[offset]?.op === 'align') {
          await deliverAlign(scene.sceneId, firstIndex + offset, result)
        }
      }
      appliedCommands = scene.commands.length
    }
    currentSceneId = scene.sceneId
    currentRevision = scene.revision
    label.textContent = scene.label
    meta.textContent = `${scene.format} · revision ${scene.revision}`
    hideStatus()
    return true
  } catch (reason) {
    showStatus(`Could not load ${scene.label}.\n${messageOf(reason)}`, 'error')
    throw reason
  }
}

/** Primary structure of a scene; older snapshots lack the structures array. */
function primaryStructureOf(scene: SceneSnapshot): SceneStructureSnapshot {
  return scene.structures?.[0] ?? {
    id: 'structure',
    label: scene.label,
    format: scene.format,
    ...(scene.fileResourceUri === undefined ? {} : { fileResourceUri: scene.fileResourceUri }),
    ...(scene.fileGzip === undefined ? {} : { fileGzip: scene.fileGzip }),
  }
}

async function readStructure(
  scene: SceneSnapshot,
  structure: SceneStructureSnapshot,
): Promise<string | Uint8Array> {
  const uri = structure.fileResourceUri
    ?? `mol4agent://structure/${scene.sceneId}/${encodeURIComponent(structure.id)}`
  const resource = await withTimeout(
    app.readServerResource({ uri }),
    15_000,
    `timed out reading ${structure.label}`,
  )
  let data = decodeStructure(resource)
  if (structure.fileGzip === true) {
    const raw = typeof data === 'string' ? new TextEncoder().encode(data) : data
    data = await gunzipBytes(raw, MAX_STRUCTURE_BYTES)
  }
  return data
}

async function deliverAlign(
  sceneId: string,
  commandIndex: number,
  result: CommandResult,
): Promise<void> {
  const answer = result.ok && result.data !== undefined
    ? { ok: true, result: result.data }
    : {
      ok: false,
      message: result.ok ? 'the viewer returned no alignment metrics' : result.message,
    }
  await app.callServerTool({
    name: 'mol_align_deliver',
    arguments: {
      sceneId,
      commandIndex,
      data: JSON.stringify(answer),
    },
  }).catch(reason => { console.warn('[mol4agent] align delivery failed', reason) })
}

async function deliverInspect(pending: PendingInspect): Promise<void> {
  try {
    const currentViewer = await ensureViewer()
    const result = currentViewer.inspect(pending.request)
    await app.callServerTool({
      name: 'mol_inspect_deliver',
      arguments: {
        queryId: pending.queryId,
        data: await encodeInspectAnswer({ ok: true, result }),
      },
    })
  } catch (reason) {
    const message = messageOf(reason)
    await app.callServerTool({
      name: 'mol_inspect_fail',
      arguments: { queryId: pending.queryId, message },
    }).catch(() => {})
  }
}

async function deliverTmScore(pending: PendingTmScore): Promise<void> {
  try {
    const currentViewer = await ensureViewer()
    const result = currentViewer.tmScore(pending.request)
    await app.callServerTool({
      name: 'mol_tmscore_deliver',
      arguments: {
        queryId: pending.queryId,
        data: encodeTmScoreAnswer({ ok: true, result }),
      },
    })
  } catch (reason) {
    const message = messageOf(reason)
    await app.callServerTool({
      name: 'mol_tmscore_fail',
      arguments: { queryId: pending.queryId, message },
    }).catch(() => {})
  }
}

async function deliverCapture(capture: PendingCapture): Promise<void> {
  try {
    await applyScene(capture.scene)
    const currentViewer = await ensureViewer()
    const png = await captureWithContent(currentViewer, capture)
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

async function captureWithContent(viewer: MolViewer, capture: PendingCapture): Promise<Uint8Array> {
  let last: Uint8Array | undefined
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await waitForRenderable(viewer, 10_000)
    last = await viewer.capture({
      width: capture.width,
      height: capture.height,
      transparent: capture.transparent,
    })
    if (await hasVisibleContent(last)) return last
    await sleep(350)
  }
  if (last === undefined) throw new Error('the viewer produced no image')
  throw new Error(
    'the viewer rendered only the background; wait for the structure to finish loading and retry',
  )
}

async function waitForRenderable(viewer: MolViewer, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    viewer.resize()
    const diagnostics = viewer.diagnostics()
    if (
      diagnostics.host.clientWidth > 0
      && diagnostics.host.clientHeight > 0
      && diagnostics.canvas.clientWidth > 0
      && diagnostics.canvas.clientHeight > 0
      && diagnostics.atoms > 0
      && diagnostics.representations > 0
    ) {
      // Let Mol* present the freshly applied representation.
      await sleep(250)
      return
    }
    await sleep(100)
  }
}

async function hasVisibleContent(png: Uint8Array): Promise<boolean> {
  if (typeof createImageBitmap !== 'function') return true
  let bitmap: ImageBitmap | undefined
  try {
    bitmap = await createImageBitmap(new Blob([png as unknown as BlobPart], { type: 'image/png' }))
    const width = 96
    const height = Math.max(1, Math.round((bitmap.height / bitmap.width) * width))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (context === null) return true
    context.drawImage(bitmap, 0, 0, width, height)
    const data = context.getImageData(0, 0, width, height).data
    const r0 = data[0] ?? 0
    const g0 = data[1] ?? 0
    const b0 = data[2] ?? 0
    const a0 = data[3] ?? 0
    let different = 0
    for (let index = 0; index < data.length; index += 4) {
      const delta = Math.abs((data[index] ?? 0) - r0)
        + Math.abs((data[index + 1] ?? 0) - g0)
        + Math.abs((data[index + 2] ?? 0) - b0)
        + Math.abs((data[index + 3] ?? 0) - a0)
      if (delta > 24) different += 1
    }
    return different / (width * height) >= 0.005
  } catch {
    return true
  } finally {
    bitmap?.close()
  }
}

async function ensureViewer(): Promise<MolViewer> {
  if (viewer !== null) return viewer
  showStatus('Starting Mol*…')
  viewer = await createMolViewer({
    container: viewerHost,
    theme,
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

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(message)) }, ms)
    promise.then(value => {
      clearTimeout(timer)
      resolve(value)
    }, reason => {
      clearTimeout(timer)
      reject(reason)
    })
  })
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

export type { MolFormat }
