/**
 * Minimal MCP Apps host used by the UI smoke test.
 *
 * It wraps the viewer in an iframe, connects the official AppBridge, serves one
 * scene, then requests a capture. The Node harness writes the PNG to disk.
 */
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge'
import type { CallToolRequest, CallToolResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js'

const resultElement = document.getElementById('result') as HTMLPreElement
const mount = document.getElementById('mount') as HTMLDivElement
const captureElement = document.getElementById('capture') as HTMLImageElement

const scene = {
  sceneId: 'test-scene',
  revision: 2,
  label: '1atp.pdb',
  format: 'pdb',
  commands: [
    { op: 'represent', style: { type: 'cartoon', color: 'chain-id' } },
    { op: 'select', target: { kind: 'ligand' }, mode: 'highlight', focus: true },
  ],
} as const

let captureRequested = false
let captureDelivered = false
let failures = 0

const iframe = document.createElement('iframe')
iframe.id = 'app'
iframe.title = 'mol4agent test app'
iframe.style.cssText = 'width:100%;height:620px;border:0;display:block'
mount.appendChild(iframe)

const bridge = new AppBridge(
  null,
  { name: 'mol4agent-test-host', version: '0.0.0' },
  {
    serverTools: {},
    serverResources: {},
    openLinks: {},
    logging: {},
  },
  {
    hostContext: {
      theme: 'dark',
      displayMode: 'inline',
      availableDisplayModes: ['inline', 'fullscreen'],
      containerDimensions: { width: 1000, height: 620 },
      locale: 'en',
    },
  },
)

bridge.onreadresource = async (params): Promise<ReadResourceResult> => {
  if (params.uri !== 'mol4agent://structure/test-scene') throw new Error(`unknown resource ${params.uri}`)
  const response = await fetch('/fixture.pdb')
  if (!response.ok) throw new Error(`fixture fetch failed: ${String(response.status)}`)
  return {
    contents: [{ uri: params.uri, mimeType: 'text/plain', text: await response.text() }],
  }
}

bridge.oncalltool = async (params: CallToolRequest['params']): Promise<CallToolResult> => {
  switch (params.name) {
    case 'mol_viewer_poll': {
      const args = params.arguments as { sceneId?: unknown; revision?: unknown } | undefined
      const hasScene = args?.sceneId === scene.sceneId && args.revision === scene.revision
      if (captureDelivered) {
        return { content: [{ type: 'text', text: 'idle' }], structuredContent: { scene: null, capture: null, timedOut: true } }
      }
      if (!hasScene) {
        return { content: [{ type: 'text', text: 'scene' }], structuredContent: { scene, capture: null, timedOut: false } }
      }
      if (!captureRequested) {
        await new Promise(resolve => { setTimeout(resolve, 200) })
        return { content: [{ type: 'text', text: 'wait' }], structuredContent: { scene: null, capture: null, timedOut: true } }
      }
      return {
        content: [{ type: 'text', text: 'capture' }],
        structuredContent: {
          scene,
          capture: {
            captureId: 'capture-1',
            scene,
            width: 800,
            height: 600,
            transparent: false,
            createdAt: Date.now(),
          },
          timedOut: false,
        },
      }
    }
    case 'mol_capture_deliver': {
      const args = params.arguments as { data?: unknown; width?: unknown; height?: unknown } | undefined
      if (typeof args?.data !== 'string') return errorResult('missing capture data')
      captureDelivered = true
      try {
        const response = await fetch('/capture', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ data: args.data, width: args.width, height: args.height }),
        })
        const info = await response.json()
        captureElement.src = `data:image/png;base64,${args.data}`
        captureElement.hidden = false
        resultElement.textContent = JSON.stringify({ ok: true, ...info })
        document.title = 'CAPTURE_READY'
        return { content: [{ type: 'text', text: 'delivered' }], structuredContent: { ok: true, ...info } }
      } catch (reason) {
        return errorResult(`capture upload failed: ${reason instanceof Error ? reason.message : String(reason)}`)
      }
    }
    case 'mol_capture_fail': {
      const args = params.arguments as { message?: unknown } | undefined
      failures += 1
      resultElement.textContent = JSON.stringify({ ok: false, message: String(args?.message ?? 'capture failed') })
      return { content: [{ type: 'text', text: 'recorded' }] }
    }
    default:
      return errorResult(`unexpected app tool ${params.name}`)
  }
}

bridge.oninitialized = async () => {
  try {
    await bridge.sendToolInput({ arguments: { path: '1atp.pdb' } })
    await bridge.sendToolResult({
      content: [{ type: 'text', text: '1atp.pdb opened' }],
      structuredContent: { scene },
    })
    setTimeout(() => { captureRequested = true }, 10_000)
  } catch (reason) {
    resultElement.textContent = JSON.stringify({
      ok: false,
      message: reason instanceof Error ? reason.message : String(reason),
    })
  }
}

function errorResult(message: string): CallToolResult {
  failures += 1
  resultElement.textContent = JSON.stringify({ ok: false, message })
  return { isError: true, content: [{ type: 'text', text: message }] }
}

await bridge.connect(new PostMessageTransport(iframe.contentWindow ?? undefined, iframe.contentWindow ?? window))
iframe.src = '/viewer.html'

setTimeout(() => {
  if (resultElement.textContent === 'pending') {
    resultElement.textContent = JSON.stringify({
      ok: false,
      message: failures > 0 ? 'app failed before capture' : 'timed out waiting for capture',
    })
  }
}, 55_000)
