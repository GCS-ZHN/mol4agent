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
import { AlignHub } from './align.ts'
import { CaptureHub } from './capture.ts'
import { InspectHub, TmScoreHub } from './inspect.ts'
import { SceneStore } from './scene.ts'
import { registerMolTools } from './tools.ts'

export const VERSION = '0.3.0'

const INSTRUCTIONS = `mol4agent provides an interactive 3D molecular viewer.

- Use mol_info before choosing chains or residues; never read a whole PDB/mmCIF file as plain text.
- Use mol_fetch when the user names a database entry instead of a local file; it downloads from RCSB PDB, AlphaFold DB, PubChem, or ChEMBL to target_path. Then call mol_open on the returned path.
- Use mol_open to display a structure. The viewer appears in the conversation and stays live.
- Use mol_add_structure to load a second structure into the same scene, and mol_list_structures to see ids.
- Use mol_style, mol_select, mol_focus, and mol_measure to operate the open scene.
- Use mol_align to superpose one structure onto another; use mol_tmscore for a read-only TM-score
  comparison that moves nothing.
- Use mol_inspect to read the live viewer state (residues, coordinates, counts, styles, visible colour)
  instead of parsing the structure file; it also sees changes a human made in the Mol* panel.
- Use mol_capture to return a PNG screenshot; the viewer must be open.
- Selectors are JSON objects such as {"kind":"ligand"}, {"kind":"chain","chain":"A"},
  {"kind":"residues","chain":"A","start":10,"end":25}, or {"kind":"comp","compId":"ATP"}.
  Add "structureId" to disambiguate structures with identical chain ids.
- Paths may be absolute or relative to the workspace root.`

/** Build a fully configured server. Exported for protocol-level tests. */
export async function createServer(options?: {
  readonly viewerHtml?: string
  readonly captureTimeoutMs?: number
  readonly inspectTimeoutMs?: number
  readonly alignTimeoutMs?: number
  readonly tmScoreTimeoutMs?: number
  readonly maxFileBytes?: number
  readonly fetchTimeoutMs?: number
  readonly fetchImpl?: typeof fetch
}): Promise<McpServer> {
  const viewerHtml = options?.viewerHtml ?? await readViewerHtml()
  const server = new McpServer(
    { name: 'mol4agent', version: VERSION },
    { instructions: INSTRUCTIONS },
  )

  registerMolTools(server, {
    store: new SceneStore(),
    captures: new CaptureHub(),
    inspects: new InspectHub(),
    tmscores: new TmScoreHub(),
    aligns: new AlignHub(),
    viewerHtml,
    maxFileBytes: options?.maxFileBytes ?? 64 * 1024 * 1024,
    fetchTimeoutMs: options?.fetchTimeoutMs ?? readPositiveInt('MOL4AGENT_FETCH_TIMEOUT_MS', 30_000),
    captureTimeoutMs: options?.captureTimeoutMs ?? readPositiveInt('MOL4AGENT_CAPTURE_TIMEOUT_MS', 45_000),
    inspectTimeoutMs: options?.inspectTimeoutMs ?? readPositiveInt('MOL4AGENT_INSPECT_TIMEOUT_MS', 30_000),
    alignTimeoutMs: options?.alignTimeoutMs ?? readPositiveInt('MOL4AGENT_ALIGN_TIMEOUT_MS', 60_000),
    tmScoreTimeoutMs: options?.tmScoreTimeoutMs ?? readPositiveInt('MOL4AGENT_TMSCORE_TIMEOUT_MS', 30_000),
    captureWidth: readPositiveInt('MOL4AGENT_CAPTURE_WIDTH', 1024),
    captureHeight: readPositiveInt('MOL4AGENT_CAPTURE_HEIGHT', 768),
    ...(options?.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
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
