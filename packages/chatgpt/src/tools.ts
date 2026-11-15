/**
 * Agent-facing `mol_*` tools and the MCP App UI resource.
 *
 * The server owns paths and bytes; the app owns WebGL. Mutating tools append a
 * JSON command to the scene log and wake the app's long-poll. `mol_capture`
 * blocks while the app claims the request, renders a PNG, and commits it back.
 *
 * @module @gcszhn/mol4agent-chatgpt/tools
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'
import { z } from 'zod'
import {
  COLOR_THEMES,
  REPRESENTATION_TYPES,
  type MolCommand,
  type StyleSpec,
  type StructureSummary,
} from '@gcszhn/mol4agent-core/protocol'
import { summarizeStructure } from '@gcszhn/mol4agent-core/parse'
import { CaptureHub } from './capture.ts'
import { isBinaryFormat } from './formats.ts'
import { findInterfaceResidues, type InterfaceResult } from './interface.ts'
import { resolveMoleculeFile, workspaceRoot, type ResolvedMoleculeFile } from './paths.ts'
import { SceneStore, type SceneSnapshot } from './scene.ts'
import { normalizeSelector } from './selector.ts'

/** UI resource served by this MCP server. */
export const VIEWER_URI = 'ui://mol4agent/viewer.html'

/** Structure resource prefix; the app reads bytes through this. */
export const STRUCTURE_URI_PREFIX = 'mol4agent://structure/'

const SELECTOR_HELP =
  'A StructureSelector object. Examples: {"kind":"ligand"}, {"kind":"protein"}, '
  + '{"kind":"chain","chain":"A"}, {"kind":"residues","chain":"A","start":10,"end":25}, '
  + '{"kind":"residue","chain":"A","index":42}, {"kind":"comp","compId":"ATP"}'

const selectorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('polymer') }),
  z.object({ kind: z.literal('protein') }),
  z.object({ kind: z.literal('nucleic') }),
  z.object({ kind: z.literal('ligand') }),
  z.object({ kind: z.literal('water') }),
  z.object({ kind: z.literal('ion') }),
  z.object({ kind: z.literal('chain'), chain: z.string().min(1) }),
  z.object({
    kind: z.literal('residue'),
    chain: z.string().min(1).optional(),
    index: z.number(),
    auth: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('residues'),
    chain: z.string().min(1).optional(),
    start: z.number(),
    end: z.number(),
    auth: z.boolean().optional(),
  }),
  z.object({ kind: z.literal('comp'), compId: z.string().min(1) }),
  z.object({
    kind: z.literal('schema'),
    schema: z.record(z.string(), z.union([z.string(), z.number()])),
  }),
])

const colorParamsSchema = z.object({
  value: z.union([z.string(), z.number()]),
})

const styleFields = {
  type: z.enum(REPRESENTATION_TYPES).optional()
    .describe('Representation type. Defaults to cartoon when no style is given.'),
  color: z.enum(COLOR_THEMES).optional()
    .describe('Color theme. Defaults to chain-id when no style is given.'),
  colorParams: colorParamsSchema.optional()
    .describe('Color theme params. For uniform color pass {"value":16711680}.'),
}

/** Runtime dependencies shared by the tool handlers. */
export interface MolToolOptions {
  readonly store: SceneStore
  readonly captures: CaptureHub
  readonly viewerHtml: string
  readonly maxFileBytes: number
  readonly captureTimeoutMs: number
  readonly captureWidth: number
  readonly captureHeight: number
}

/** Register every tool and resource the plugin exposes. */
export function registerMolTools(server: McpServer, options: MolToolOptions): void {
  const { store, captures } = options

  registerAppResource(
    server,
    'mol4agent viewer',
    VIEWER_URI,
    {
      description: 'Interactive Mol* structure viewer used by the mol_* tools.',
      _meta: { ui: { prefersBorder: true } },
    },
    async () => ({
      contents: [{
        uri: VIEWER_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: options.viewerHtml,
        _meta: {
          ui: {
            prefersBorder: true,
            csp: {
              connectDomains: [],
              resourceDomains: [],
              frameDomains: [],
              baseUriDomains: [],
            },
          },
        },
      }],
    }),
  )

  server.registerResource(
    'mol4agent structure',
    new ResourceTemplate(STRUCTURE_URI_PREFIX + '{sceneId}', { list: undefined }),
    {
      description: 'Raw bytes of one open structure, read by the mol4agent app.',
    },
    async (uri, variables) => {
      const rawSceneId = variables.sceneId
      const sceneId = Array.isArray(rawSceneId) ? rawSceneId[0] : rawSceneId
      if (sceneId === undefined) throw new Error('missing sceneId')
      const record = store.record(sceneId)
      if (record === undefined) throw new Error(`structure scene ${sceneId} is no longer available`)
      if (isBinaryFormat(record.format)) {
        return {
          contents: [{
            uri: uri.href,
            mimeType: 'application/octet-stream',
            blob: Buffer.from(record.bytes).toString('base64'),
          }],
        }
      }
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'text/plain',
          text: new TextDecoder('utf-8', { fatal: false }).decode(record.bytes),
        }],
      }
    },
  )

  server.registerTool('mol_info', {
    title: 'Inspect a molecular structure',
    description: 'Summarize a molecular structure file (PDB, mmCIF, SDF, MOL2, XYZ, GRO, ...) '
      + 'without opening the viewer. Returns chains, residue/atom counts, and ligands. Use it before '
      + 'choosing chains or residues; never read a whole structure file as plain text.',
    inputSchema: {
      path: z.string().min(1).describe('Structure file path, absolute or relative to the workspace.'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args, extra) => {
    const file = await resolveMoleculeFile(server, args.path, options.maxFileBytes, extra.signal)
    return textResult(`${describeFile(file)}\n\nUse mol_open to display it in the viewer.`)
  })

  server.registerTool('mol_interface', {
    title: 'Find interface residues',
    description: 'Find interface residues between two chain groups within a distance cutoff '
      + '(default 8 A). Returns residue ranges usable as mol_style targets. Currently supports '
      + 'PDB-like ATOM files (pdb/pdbqt/pqr).',
    inputSchema: {
      path: z.string().min(1).describe('Structure file path.'),
      chainsA: z.array(z.string()).min(1).describe('Chain ids on the first side, e.g. ["A","C"].'),
      chainsB: z.array(z.string()).min(1).describe('Chain ids on the second side, e.g. ["B","D"].'),
      cutoff: z.number().gt(0).max(30).optional().describe('Distance cutoff in angstroms. Default 8.'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args, extra) => {
    const file = await resolveMoleculeFile(server, args.path, options.maxFileBytes, extra.signal)
    if (file.format !== 'pdb' && file.format !== 'pdbqt' && file.format !== 'pqr') {
      throw new Error(`interface calculation supports PDB-like ATOM files only; received ${file.format}`)
    }
    const chainsA = args.chainsA.map(chain => chain.trim()).filter(Boolean)
    const chainsB = args.chainsB.map(chain => chain.trim()).filter(Boolean)
    if (chainsA.length === 0 || chainsB.length === 0) throw new Error('chainsA and chainsB must not be empty')
    return textResult(formatInterface(file.label, findInterfaceResidues(file.bytes, {
      chainsA,
      chainsB,
      cutoff: args.cutoff ?? 8,
    })))
  })

  registerAppTool(server, 'mol_open', {
    title: 'Open a molecular structure',
    description: 'Open a molecular structure in the mol4agent 3D viewer and make it the active scene. '
      + 'Optionally set the representation/color and highlight a selection. The viewer appears in the '
      + 'conversation and updates when later mol_style/mol_select/mol_focus/mol_measure calls run.',
    inputSchema: {
      path: z.string().min(1).describe('Structure file path, absolute or relative to the workspace.'),
      ...styleFields,
      select: selectorSchema.optional()
        .describe(`Optional selection to highlight after loading. ${SELECTOR_HELP}`),
      focus: z.boolean().optional()
        .describe('Focus the camera on the selection (or the whole structure when no selection is given).'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: VIEWER_URI } },
  }, async (args, extra) => {
    const file = await resolveMoleculeFile(server, args.path, options.maxFileBytes, extra.signal)
    const commands: MolCommand[] = [{ op: 'represent', style: styleOf(args) }]
    if (args.select !== undefined) {
      commands.push({
        op: 'select',
        target: normalizeSelector(args.select),
        mode: 'highlight',
        ...(args.focus === true ? { focus: true } : {}),
      })
    } else if (args.focus === true) {
      commands.push({ op: 'focus' })
    }
    const scene = store.open({
      path: file.absolutePath,
      label: file.label,
      format: file.format,
      bytes: file.bytes,
      commands,
    })
    return textResult(
      `${describeFile(file)}\n\nOpened ${file.label} in the mol4agent viewer. `
      + 'Use mol_style, mol_select, mol_focus, mol_measure, or mol_capture to operate it.',
      { scene },
    )
  })

  server.registerTool('mol_style', {
    title: 'Change representation or color',
    description: 'Change the representation or color theme of the active structure. Without target this '
      + 'replaces the scene representation. With target it adds a representation only to that selection.',
    inputSchema: {
      ...styleFields,
      target: selectorSchema.optional()
        .describe(`Optional selection to style additively. ${SELECTOR_HELP}`),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args) => {
    const command: MolCommand = {
      op: 'represent',
      style: styleOf(args),
      ...(args.target === undefined ? {} : { target: normalizeSelector(args.target) }),
    }
    const scene = requireScene(store, 'style')
    const next = store.push(command)
    return textResult(describeStyle(args), { scene: next ?? scene })
  })

  server.registerTool('mol_select', {
    title: 'Select or highlight part of the structure',
    description: 'Select, highlight, or focus part of the active structure. Use a StructureSelector; '
      + 'the selection is rendered in the open viewer.',
    inputSchema: {
      target: selectorSchema.describe(SELECTOR_HELP),
      mode: z.enum(['select', 'highlight']).optional().describe('Selection mode. Default select.'),
      focus: z.boolean().optional().describe('Move the camera to the selection.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args) => {
    const scene = requireScene(store, 'select')
    const target = normalizeSelector(args.target)
    const next = store.push({
      op: 'select',
      target,
      mode: args.mode ?? 'select',
      ...(args.focus === true ? { focus: true } : {}),
    })
    return textResult(
      `${args.mode === 'highlight' ? 'Highlighted' : 'Selected'} ${describeSelector(target)}`
      + `${args.focus === true ? ' and focused the camera' : ''}.`,
      { scene: next ?? scene },
    )
  })

  server.registerTool('mol_focus', {
    title: 'Focus the camera',
    description: 'Move the camera to a selection, or to the whole structure when target is omitted.',
    inputSchema: {
      target: selectorSchema.optional().describe(`Optional selection to focus. ${SELECTOR_HELP}`),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args) => {
    const scene = requireScene(store, 'focus')
    const target = args.target === undefined ? undefined : normalizeSelector(args.target)
    const next = store.push({ op: 'focus', ...(target === undefined ? {} : { target }) })
    return textResult(
      target === undefined ? 'Focused the whole structure.' : `Focused ${describeSelector(target)}.`,
      { scene: next ?? scene },
    )
  })

  server.registerTool('mol_measure', {
    title: 'Measure a distance, angle, or dihedral',
    description: 'Add a distance (2 targets), angle (3 targets), or dihedral (4 targets) measurement '
      + 'between selections in the active viewer. Use residue/chain/comp selectors, not raw coordinates.',
    inputSchema: {
      kind: z.enum(['distance', 'angle', 'dihedral']),
      targets: z.array(selectorSchema).min(2).max(4)
        .describe(`Exactly 2 targets for distance, 3 for angle, 4 for dihedral. ${SELECTOR_HELP}`),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args) => {
    const scene = requireScene(store, 'measure')
    const needed = args.kind === 'distance' ? 2 : args.kind === 'angle' ? 3 : 4
    if (args.targets.length !== needed) {
      throw new Error(`${args.kind} needs exactly ${needed} targets; got ${args.targets.length}`)
    }
    const next = store.push({
      op: 'measure',
      kind: args.kind,
      targets: args.targets.map(target => normalizeSelector(target)),
    })
    return textResult(`Added a ${args.kind} measurement.`, { scene: next ?? scene })
  })

  server.registerTool('mol_capture', {
    title: 'Capture the viewer as PNG',
    description: 'Capture the current molecular viewer viewport as a PNG and attach it to this tool result. '
      + 'The viewer must be open; the app renders the image and returns it. Use it to visually verify a view '
      + 'or show a figure to the user.',
    inputSchema: {
      width: z.number().int().min(64).max(4096).optional()
        .describe(`Capture width in pixels. Default ${options.captureWidth}.`),
      height: z.number().int().min(64).max(4096).optional()
        .describe(`Capture height in pixels. Default ${options.captureHeight}.`),
      transparent: z.boolean().optional().describe('Render with a transparent background.'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args, extra) => {
    const scene = requireScene(store, 'capture')
    const width = args.width ?? options.captureWidth
    const height = args.height ?? options.captureHeight
    const pending = captures.enqueue({
      scene,
      width,
      height,
      transparent: args.transparent === true,
    })
    store.wake()
    const delivery = await captures.wait(pending.captureId, options.captureTimeoutMs, extra.signal)
    const text = `Screenshot of ${scene.label} saved to ${delivery.path} (${delivery.width}x${delivery.height} px).`
    return {
      content: [
        { type: 'text', text },
        { type: 'image', data: Buffer.from(delivery.png).toString('base64'), mimeType: 'image/png' },
      ],
      structuredContent: {
        savedPath: delivery.path,
        width: delivery.width,
        height: delivery.height,
        scene,
        ...(delivery.diagnostics === undefined ? {} : { diagnostics: delivery.diagnostics }),
      },
    }
  })

  // ---- App-only tools -----------------------------------------------------

  server.registerTool('mol_viewer_poll', {
    title: 'Wait for viewer changes',
    description: 'Internal app tool: long-poll for a scene revision change or a pending capture. '
      + 'Not intended for the model.',
    inputSchema: {
      sceneId: z.string().optional().describe('The scene the app currently has.'),
      revision: z.number().int().optional().describe('The scene revision the app has applied.'),
      timeoutMs: z.number().int().min(1000).max(30_000).optional().describe('Server wait budget. Default 20000.'),
    },
    _meta: { ui: { visibility: ['app'] } },
  }, async (args, extra) => {
    const deadline = Date.now() + (args.timeoutMs ?? 20_000)
    while (!extra.signal.aborted) {
      const scene = store.snapshot()
      const sceneChanged = scene !== null
        && (args.sceneId === undefined || scene.sceneId !== args.sceneId || scene.revision !== args.revision)
      if (sceneChanged) return pollResult(scene, null, false)

      const capture = captures.claim(scene?.sceneId)
      if (capture !== null) return pollResult(scene ?? capture.scene, capture, false)

      const remaining = deadline - Date.now()
      if (remaining <= 0) return pollResult(scene, null, true)
      const status = await store.waitForChange(Math.min(remaining, 5000), extra.signal)
      if (status === 'aborted') break
    }
    return pollResult(store.snapshot(), null, false)
  })

  server.registerTool('mol_capture_deliver', {
    title: 'Deliver a screenshot',
    description: 'Internal app tool: commit a rendered PNG for a pending mol_capture request.',
    inputSchema: {
      captureId: z.string().min(1),
      data: z.string().min(1).describe('Base64 PNG bytes.'),
      width: z.number().int().min(1),
      height: z.number().int().min(1),
      diagnostics: z.record(z.string(), z.unknown()).optional(),
    },
    _meta: { ui: { visibility: ['app'] } },
  }, async (args, extra) => {
    const png = decodeBase64Png(args.data)
    const root = await workspaceRoot(server, extra.signal)
    const path = await saveCapture(root, args.captureId, png)
    if (!captures.deliver(args.captureId, {
      png,
      width: args.width,
      height: args.height,
      path,
      ...(args.diagnostics === undefined ? {} : { diagnostics: args.diagnostics }),
    })) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'The capture request expired before the screenshot arrived.' }],
      }
    }
    return textResult(`Screenshot delivered (${args.width}x${args.height} px).`, {
      ok: true,
      path,
      width: args.width,
      height: args.height,
    })
  })

  server.registerTool('mol_capture_fail', {
    title: 'Fail a screenshot request',
    description: 'Internal app tool: report why a pending mol_capture request could not be rendered.',
    inputSchema: {
      captureId: z.string().min(1),
      message: z.string().min(1),
    },
    _meta: { ui: { visibility: ['app'] } },
  }, async (args) => {
    captures.fail(args.captureId, args.message)
    return textResult('Capture failure recorded.')
  })
}

function pollResult(
  scene: SceneSnapshot | null,
  capture: ReturnType<CaptureHub['claim']>,
  timedOut: boolean,
): CallToolResult {
  return {
    content: [{ type: 'text', text: timedOut ? 'No viewer changes.' : 'Viewer update.' }],
    structuredContent: { scene, capture, timedOut },
  }
}

function textResult(text: string, structuredContent?: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(structuredContent === undefined ? {} : { structuredContent }),
  }
}

function requireScene(store: SceneStore, action: string): SceneSnapshot {
  const scene = store.snapshot()
  if (scene === null) throw new Error(`open a structure with mol_open before trying to ${action} it`)
  return scene
}

function styleOf(args: {
  readonly type?: StyleSpec['type']
  readonly color?: StyleSpec['color']
  readonly colorParams?: { readonly value: string | number }
}): StyleSpec {
  const style: {
    type?: StyleSpec['type']
    color?: StyleSpec['color']
    colorParams?: { value: string | number }
  } = {}
  if (args.type !== undefined) style.type = args.type
  if (args.color !== undefined) style.color = args.color
  if (args.colorParams !== undefined) style.colorParams = { value: args.colorParams.value }
  return Object.keys(style).length === 0 ? { type: 'cartoon', color: 'chain-id' } : style
}

function describeStyle(args: {
  readonly type?: StyleSpec['type']
  readonly color?: StyleSpec['color']
  readonly target?: unknown
}): string {
  const style = [args.type ?? 'cartoon', args.color ?? 'chain-id'].join(' / ')
  if (args.target === undefined) return `Applied ${style} to the whole structure.`
  return `Applied ${style} to ${describeSelector(normalizeSelector(args.target))}.`
}

function describeSelector(value: { readonly kind: string } & Record<string, unknown>): string {
  switch (value.kind) {
    case 'chain': return `chain ${String(value.chain)}`
    case 'residue': return `residue ${String(value.chain ?? '')}${String(value.index)}`.trim()
    case 'residues': return `residues ${String(value.chain ?? '')}${String(value.start)}-${String(value.end)}`.trim()
    case 'comp': return `residues named ${String(value.compId)}`
    default: return value.kind
  }
}

function describeFile(file: ResolvedMoleculeFile): string {
  const head = `<structure path="${escapeAttribute(file.absolutePath)}" format="${file.format}" bytes="${file.bytes.byteLength}">`
  let summary: StructureSummary
  try {
    summary = summarizeStructure({ data: file.bytes, format: file.format, label: file.label })
  } catch {
    return `${head}\n(summary unavailable for this format; the viewer can still render it)\n</structure>`
  }
  const chains = summary.chains.length === 0
    ? '(none)'
    : summary.chains
      .map(chain => `- ${chain.id}: ${chain.kind}, ${chain.residues} residues, ${chain.atoms} atoms`
        + `${chain.compIds.length === 0 ? '' : ` [${chain.compIds.join(', ')}]`}`)
      .join('\n')
  const ligands = summary.ligands.length === 0
    ? 'none'
    : summary.ligands.map(ligand => `${ligand.compId} x${ligand.count}`).join(', ')
  return [
    head,
    `atoms: ${summary.atomCount}, residues: ${summary.residueCount}, models: ${summary.modelCount}`,
    'chains:',
    chains,
    `ligands: ${ligands}`,
    '</structure>',
  ].join('\n')
}

function formatInterface(label: string, result: InterfaceResult): string {
  if (result.residues.length === 0) {
    return `No interface residues within ${result.cutoff} A for ${label}.`
  }
  const ranges = result.ranges.map(range => range.start === range.end
    ? `chain ${range.chain}: ${range.start}`
    : `chain ${range.chain}: ${range.start}-${range.end}`)
  return `Interface of ${label} at ${result.cutoff} A: ${result.residues.length} residues, `
    + `${result.ranges.length} ranges (${result.contactPairs} residue pairs).\n`
    + ranges.map(line => `- ${line}`).join('\n')
    + '\n\nStyle a range with mol_style target {"kind":"residues","chain":"A","start":26,"end":33}.\n'
    + `JSON: ${JSON.stringify({ cutoff: result.cutoff, residues: result.residues, ranges: result.ranges })}`
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

function decodeBase64Png(data: string): Uint8Array {
  const compact = data.replace(/\s+/gu, '')
  if (compact.length === 0 || compact.length % 4 !== 0) throw new Error('capture data is not valid base64')
  if (compact.length > 24_000_000) throw new Error('capture is too large (limit 24 MB base64)')
  const png = new Uint8Array(Buffer.from(compact, 'base64'))
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (png.byteLength < signature.length || signature.some((value, index) => png[index] !== value)) {
    throw new Error('capture data is not a PNG')
  }
  return png
}

async function saveCapture(root: string, captureId: string, png: Uint8Array): Promise<string> {
  const directory = join(root, '.mol4agent', 'captures')
  await mkdir(directory, { recursive: true })
  const file = join(directory, `mol4agent-${Date.now()}-${captureId.slice(0, 8)}.png`)
  await writeFile(file, png)
  return file
}
