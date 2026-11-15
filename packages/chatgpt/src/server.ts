/**
 * stdio MCP server for the ChatGPT/Codex plugin.
 *
 * stdout is the MCP wire; diagnostics go to stderr. The viewer HTML is read
 * from `lib/viewer.html`, next to the bundled `lib/server.js`.
 *
 * @module @gcszhn/mol4agent-chatgpt/server
 */
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CaptureHub } from './capture.ts'
import { SceneStore } from './scene.ts'
import { registerMolTools } from './tools.ts'

export const VERSION = '0.1.0'

const INSTRUCTIONS = `mol4agent provides an interactive 3D molecular viewer.

- Use mol_info before choosing chains or residues; never read a whole PDB/mmCIF file as plain text.
- Use mol_open to display a structure. The viewer appears in the conversation and stays live.
- Use mol_style, mol_select, mol_focus, and mol_measure to operate the open structure.
- Use mol_capture to return a PNG screenshot; the viewer must be open.
- Selectors are JSON objects such as {"kind":"ligand"}, {"kind":"chain","chain":"A"},
  {"kind":"residues","chain":"A","start":10,"end":25}, or {"kind":"comp","compId":"ATP"}.
- Paths may be absolute or relative to the workspace root.`

/** Build a fully configured server. Exported for protocol-level tests. */
export async function createServer(options?: {
  readonly viewerHtml?: string
  readonly captureTimeoutMs?: number
  readonly maxFileBytes?: number
}): Promise<McpServer> {
  const viewerHtml = options?.viewerHtml ?? await readViewerHtml()
  const server = new McpServer(
    { name: 'mol4agent', version: VERSION },
    { instructions: INSTRUCTIONS },
  )

  registerMolTools(server, {
    store: new SceneStore(),
    captures: new CaptureHub(),
    viewerHtml,
    maxFileBytes: options?.maxFileBytes ?? 64 * 1024 * 1024,
    captureTimeoutMs: options?.captureTimeoutMs ?? readPositiveInt('MOL4AGENT_CAPTURE_TIMEOUT_MS', 45_000),
    captureWidth: readPositiveInt('MOL4AGENT_CAPTURE_WIDTH', 1024),
    captureHeight: readPositiveInt('MOL4AGENT_CAPTURE_HEIGHT', 768),
  })
  return server
}

/** Start the stdio transport. */
export async function main(): Promise<void> {
  const server = await createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stderr.write(`[mol4agent] MCP server ${VERSION} ready\n`)

  const shutdown = (): void => {
    void server.close().finally(() => { process.exit(0) })
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

async function readViewerHtml(): Promise<string> {
  try {
    return await readFile(new URL('./viewer.html', import.meta.url), 'utf8')
  } catch {
    return '<!doctype html><meta charset="utf-8"><title>mol4agent</title>'
      + '<body style="font:14px system-ui;padding:24px">'
      + 'The mol4agent viewer build is missing. Run <code>pnpm --filter @gcszhn/mol4agent-chatgpt build</code>.'
      + '</body>'
  }
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (raw === undefined || raw === '') return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch(reason => {
    process.stderr.write(`[mol4agent] failed to start: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`)
    process.exit(1)
  })
}
