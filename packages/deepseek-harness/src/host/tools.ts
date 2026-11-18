/**
 * Agent-facing `mol_*` tools.
 *
 * Every tool either reads a file on the Host (so the model gets a summary
 * without the file's text) or writes an intent into the session projection
 * (so the open browser page changes). The capture tool blocks until the
 * browser delivers a PNG through the internal session command.
 *
 * @module @gcszhn/mol4agent-deepseekharness/host/tools
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-attachment'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineTool, ToolArgsError, ToolContextUnavailableError } from '@deepseek-ai/dsh-tools'
import {
  COLOR_THEMES,
  DEFAULT_INSPECT_LIMIT,
  INSPECT_DETAILS,
  Mol4AgentError,
  REPRESENTATION_TYPES,
  formatColor,
  isInspectDetail,
  parseColor,
  type StructureSummary,
} from '@gcszhn/mol4agent-core/protocol'
import { SOURCE_DATABASES, resolveSource, type ResolvedSource } from '@gcszhn/mol4agent-core/sources'
import { summarizeStructure } from '@gcszhn/mol4agent-core/parse'
import { baseNameOf } from '../formats.ts'
import { canonicalTabPath } from '../tab-path.ts'
import { normalizeSelector } from '../selector.ts'
import type { MolSceneState, MolSessionState } from '../state.ts'
import { captureFileName, type CaptureHub } from './capture.ts'
import { downloadMoleculeSource, FetchTargetError, resolveFetchTarget } from './fetch.ts'
import { formatInspectResult } from './format-inspect.ts'
import type { InspectHub } from './inspect.ts'
import { findInterfaceResidues, type InterfaceResult } from './interface.ts'
import { resolveMoleculeFile, type ResolvedMoleculeFile } from './paths.ts'

export interface MolToolOptions {
  readonly hub: CaptureHub
  readonly inspectHub: InspectHub
  /** Read a tab page scene; defaults to the projection's active tab. */
  readonly sceneOf: (session: Session, tab?: string) => MolSceneState | undefined
  readonly maxFileBytes: number
  readonly fetchTimeoutMs: number
  readonly captureTimeoutMs: number
  readonly captureWidth: number
  readonly captureHeight: number
  readonly inspectTimeoutMs: number
}

const TAB_HELP = 'Tab page id returned by mol_open (its `/`-separated absolute path). '
  + 'Defaults to the active tab; either separator addresses the same page.'

const SELECTOR_HELP =
  'A StructureSelector object. Examples: {"kind":"ligand"}, {"kind":"protein"}, '
  + '{"kind":"chain","chain":"A"}, {"kind":"residues","chain":"A","start":10,"end":25}, '
  + '{"kind":"residue","chain":"A","index":42}, {"kind":"comp","compId":"ATP"}'

/** Register every molecule tool on the context. */
export function registerTools(ctx: Context, options: MolToolOptions): void {
  ctx.tools.register(defineTool({
    name: 'mol_info',
    description: 'Summarize a molecular structure file (PDB, mmCIF, SDF, MOL2, XYZ, GRO, ...) without opening a viewer. '
      + 'Returns chains, residue/atom counts, and ligands. Use this before choosing chains or residues; '
      + 'never read a whole structure file as plain text.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to the structure file, absolute or relative to the session working directory.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, text) => [{ type: 'text', text }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const file = await resolveMoleculeFile(ctx, agent, args.path, options.maxFileBytes, exec.signal)
      return `${describeFile(file)}\n\nUse mol_open to display it in the sidebar viewer.`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mol_interface',
    description: 'Find interface residues between two chain groups within a distance cutoff (default 8 A). '
      + 'Returns residue ranges usable as mol_style targets. Currently supports PDB-like ATOM files (pdb/pdbqt/pqr).',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to the structure file, absolute or relative to the session working directory.' },
      chainsA: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'Chain ids on the first side, e.g. ["A","C"].',
      },
      chainsB: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'Chain ids on the second side, e.g. ["B","D"].',
      },
      cutoff: { type: 'number', description: 'Distance cutoff in angstroms (0 < cutoff <= 30). Defaults to 8.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, text) => [{ type: 'text', text }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const file = await resolveMoleculeFile(ctx, agent, args.path, options.maxFileBytes, exec.signal)
      if (file.format !== 'pdb' && file.format !== 'pdbqt' && file.format !== 'pqr') {
        throw new ToolArgsError([
          'interface calculation currently supports PDB-like ATOM files (pdb/pdbqt/pqr)',
          `received format: ${file.format}`,
        ])
      }
      const chainsA = args.chainsA.map(chain => chain.trim()).filter(Boolean)
      const chainsB = args.chainsB.map(chain => chain.trim()).filter(Boolean)
      if (chainsA.length === 0 || chainsB.length === 0) {
        throw new ToolArgsError(['chainsA and chainsB must each contain at least one chain id'])
      }
      const cutoff = args.cutoff ?? 8
      if (!(cutoff > 0 && cutoff <= 30)) throw new ToolArgsError(['cutoff must be between 0 and 30 angstroms'])
      return formatInterface(file.label, findInterfaceResidues(file.bytes, { chainsA, chainsB, cutoff }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mol_fetch',
    description: 'Download a molecular structure from an online database and save it to a path. '
      + 'Use it when the user names a database entry instead of a local file: '
      + 'PDB ids (1crn), AlphaFold UniProt accessions (P00533), '
      + 'PubChem CIDs or names (2244, aspirin), or ChEMBL ids (CHEMBL25). '
      + 'Returns the saved path and a structure summary; use mol_open with that path to display it.',
    parameters: {
      entry_id: {
        type: 'string',
        required: true,
        description: 'Entry id or compound name for source_db. rcsb-pdb/rcsb-cif/rcsb-bcif: 4-character PDB id (1crn); '
          + 'alphafold: UniProt accession (P00533); pubchem: CID (2244) or compound name (aspirin); '
          + 'chembl: ChEMBL id (CHEMBL25).',
      },
      target_path: {
        type: 'string',
        required: true,
        description: 'Destination file path, absolute or relative to the session working directory. '
          + 'A directory or a trailing slash appends the source file name; a path without a suffix gets one.',
      },
      source_db: {
        type: 'string',
        enum: SOURCE_DATABASES,
        description: 'Source database. Defaults to rcsb-pdb.',
      },
    },
    isConcurrencySafe: () => false,
    output: {
      schema: { type: 'string' },
      render: (_args, text) => [{ type: 'text', text }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      let source: ResolvedSource
      try {
        source = resolveSource({ entryId: args.entry_id, sourceDb: args.source_db })
      } catch (error) {
        if (error instanceof Mol4AgentError) throw new ToolArgsError([error.message])
        throw error
      }
      const cwd = await ctx.workingDirectory.ensure(agent, exec.signal)
      let targetPath: string
      try {
        targetPath = await resolveFetchTarget(cwd, args.target_path, source)
      } catch (error) {
        if (error instanceof FetchTargetError) throw new ToolArgsError([error.message])
        throw error
      }
      const download = await downloadMoleculeSource({
        source,
        targetPath,
        maxBytes: options.maxFileBytes,
        timeoutMs: options.fetchTimeoutMs,
        signal: exec.signal,
      })
      const file: ResolvedMoleculeFile = {
        absolutePath: targetPath,
        format: source.format,
        label: baseNameOf(targetPath),
        bytes: download.bytes,
      }
      const tabPath = canonicalTabPath(targetPath)
      return `Downloaded ${source.description} from ${download.url}\n`
        + `saved: ${tabPath} (${download.bytes.byteLength} bytes)\n\n`
        + describeFile(file)
        + `\n\nUse mol_open with path "${tabPath}" to display it.`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mol_open',
    description: 'Open a molecular structure in a new or existing tab page (keyed by its canonical `/`-separated absolute path) and make it the active tab. '
      + 'The page opens automatically and the result includes the tab page id. Optionally set the representation/color and highlight a selection.',
    parameters: {
      path: { type: 'string', required: true, description: 'Structure file path, absolute or relative to the session working directory.' },
      type: { type: 'string', enum: REPRESENTATION_TYPES, description: 'Representation type. Defaults to cartoon.' },
      color: { type: 'string', enum: COLOR_THEMES, description: 'Color theme. Defaults to chain-id.' },
      colorParams: { type: 'json', description: 'Optional color theme params. For a uniform color pass {"value": "red"}, {"value": "#ff0000"}, or {"value": 16711680}.' },
      select: { type: 'json', description: `Optional selection to highlight after loading. ${SELECTOR_HELP}` },
      focus: { type: 'boolean', description: 'Focus the camera on the selection (or the whole structure when no selection is given).' },
    },
    isConcurrencySafe: () => false,
    output: {
      schema: { type: 'string' },
      render: (_args, text) => [{ type: 'text', text }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const file = await resolveMoleculeFile(ctx, agent, args.path, options.maxFileBytes, exec.signal)
      if (args.select !== undefined) assertSelector(args.select)
      if (args.colorParams !== undefined) assertColorParams(args.colorParams)
      return `${describeFile(file)}\n\n<viewer>Opened in the sidebar preview. Tab page: ${escapeAttribute(canonicalTabPath(file.absolutePath))}. Pass this path as tab to operate this page after opening another.</viewer>`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mol_style',
    description: 'Change the representation or color theme of a molecular viewer tab page. '
      + 'Replaces the current representations by default; pass replace:false to overlay a new style on top. target narrows which part the new representation covers.',
    parameters: {
      tab: { type: 'string', description: TAB_HELP },
      type: { type: 'string', enum: REPRESENTATION_TYPES, description: 'Representation type, e.g. cartoon or ball-and-stick.' },
      color: { type: 'string', enum: COLOR_THEMES, description: 'Color theme, e.g. chain-id, element-symbol, residue-name.' },
      target: { type: 'json', description: `Optional selection the new representation covers; it does not imply replace or overlay. ${SELECTOR_HELP}` },
      replace: { type: 'boolean', description: 'Defaults to true: clear the current representations before drawing. Pass false to keep them and overlay the new style.' },
      colorParams: { type: 'json', description: 'Optional color theme params. For a uniform color pass {"value": "red"}, {"value": "#ff0000"}, or {"value": 16711680}.' },
    },
    isConcurrencySafe: () => false,
    output: {
      schema: { type: 'string' },
      render: (_args, text) => [{ type: 'text', text }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const scene = requireScene(options, agent, args.tab, 'styling it')
      if (args.target !== undefined) assertSelector(args.target)
      if (args.colorParams !== undefined) assertColorParams(args.colorParams)
      const color = resolvedColorOf(args.colorParams)
      const style = [args.type ?? 'cartoon', args.color ?? 'chain-id'].join(' / ')
        + (color === undefined ? '' : ` ${color}`)
      const scope = args.target === undefined ? scene.label : `${scene.label} (${describeSelector(args.target)})`
      return `Applied ${style} to ${scope}.`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mol_select',
    description: 'Select, highlight, or focus part of a structure tab page. '
      + 'Use a StructureSelector; the selection is rendered in the open viewer.',
    parameters: {
      tab: { type: 'string', description: TAB_HELP },
      target: { type: 'json', required: true, description: SELECTOR_HELP },
      mode: { type: 'string', enum: ['select', 'highlight'], description: 'Selection mode. Defaults to select.' },
      focus: { type: 'boolean', description: 'Move the camera to the selection.' },
    },
    isConcurrencySafe: () => false,
    output: {
      schema: { type: 'string' },
      render: (_args, text) => [{ type: 'text', text }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const scene = requireScene(options, agent, args.tab, 'selecting')
      assertSelector(args.target)
      const mode = args.mode ?? 'select'
      return `${mode === 'highlight' ? 'Highlighted' : 'Selected'} ${describeSelector(args.target)} in ${scene.label}${args.focus === true ? ' and focused the camera' : ''}.`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mol_focus',
    description: 'Move the camera to a selection, or to the whole structure when target is omitted. '
      + 'Use it to frame an interface after styling it.',
    parameters: {
      tab: { type: 'string', description: TAB_HELP },
      target: { type: 'json', description: `Optional selection to focus. ${SELECTOR_HELP}` },
    },
    isConcurrencySafe: () => false,
    output: {
      schema: { type: 'string' },
      render: (_args, text) => [{ type: 'text', text }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const scene = requireScene(options, agent, args.tab, 'focusing')
      if (args.target !== undefined) assertSelector(args.target)
      return args.target === undefined
        ? `Focused ${scene.label}.`
        : `Focused ${describeSelector(args.target)} in ${scene.label}.`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mol_measure',
    description: 'Add a distance, angle, or dihedral measurement between exactly 2/3/4 selections in a tab page. '
      + 'Use chain/residue/residues/comp/schema selectors, not semantic categories or raw coordinates.',
    parameters: {
      tab: { type: 'string', description: TAB_HELP },
      kind: { type: 'string', required: true, enum: ['distance', 'angle', 'dihedral'], description: 'Measurement kind.' },
      targets: {
        type: 'array',
        required: true,
        description: `2 targets for distance, 3 for angle, 4 for dihedral. ${SELECTOR_HELP}`,
        items: { type: 'json' },
      },
    },
    isConcurrencySafe: () => false,
    output: {
      schema: { type: 'string' },
      render: (_args, text) => [{ type: 'text', text }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const scene = requireScene(options, agent, args.tab, 'measuring')
      const needed = args.kind === 'distance' ? 2 : args.kind === 'angle' ? 3 : 4
      if (args.targets.length !== needed) {
        throw new ToolArgsError([`${args.kind} needs exactly ${needed} targets, received ${args.targets.length}`])
      }
      for (const target of args.targets) assertMeasurementSelector(target)
      return `Added a ${args.kind} measurement to ${scene.label}.`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mol_inspect',
    description: 'Read what the molecular viewer currently shows: residue/atom identity, coordinates, '
      + 'per-component counts (waters, ligands, amino-acid types), and how the target is drawn '
      + '(representation type, colour theme, size theme, resolved colour). '
      + 'Answers come from the live Mol* page, so they include changes a human made by clicking or '
      + 'through the Mol* panel. Use it instead of parsing the structure file. Read-only: it changes nothing.',
    parameters: {
      tab: { type: 'string', description: TAB_HELP },
      target: {
        type: 'json',
        description: 'What to inspect. Omit for the whole structure. Accepts any selector, '
          + `plus {"kind":"selection"} for what is currently selected and {"kind":"focus"} for the last clicked location. ${SELECTOR_HELP}`,
      },
      detail: {
        type: 'string',
        enum: INSPECT_DETAILS,
        description: 'summary = totals, per-component counts, and styles; residues = also residue rows; '
          + 'atoms = residue rows with per-atom coordinates. Defaults to summary.',
      },
      limit: {
        type: 'integer',
        description: `Maximum residue rows to return. Defaults to ${DEFAULT_INSPECT_LIMIT}; totals and counts are never truncated.`,
      },
    },
    isConcurrencySafe: () => false,
    output: {
      schema: { type: 'string' },
      render: (_args, text) => [{ type: 'text', text }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const scene = requireScene(options, agent, args.tab, 'inspecting')
      if (args.target !== undefined) assertInspectTarget(args.target)
      if (args.detail !== undefined && !isInspectDetail(args.detail)) {
        throw new ToolArgsError([`detail must be one of ${INSPECT_DETAILS.join(', ')}`])
      }
      if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit <= 0)) {
        throw new ToolArgsError(['limit must be a positive integer'])
      }
      const answer = await options.inspectHub.wait(
        agent.id,
        String(exec.callId),
        options.inspectTimeoutMs,
        exec.signal,
      )
      if (!answer.ok) return `Could not inspect ${scene.label}: ${answer.message}`
      return formatInspectResult(answer.result)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mol_capture',
    description: 'Capture a molecular viewer tab page viewport as a PNG and attach it to this tool result. '
      + 'Use it to visually verify a view or show a figure to the user.',
    parameters: {
      tab: { type: 'string', description: TAB_HELP },
      width: { type: 'integer', description: `Capture width in pixels. Defaults to ${options.captureWidth}.` },
      height: { type: 'integer', description: `Capture height in pixels. Defaults to ${options.captureHeight}.` },
      transparent: { type: 'boolean', description: 'Render with a transparent background.' },
    },
    isConcurrencySafe: () => false,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          attachment: { type: 'json', required: true },
          width: { type: 'number', required: true },
          height: { type: 'number', required: true },
          path: { type: 'string', required: true },
          savedPath: { type: 'string' },
          imageCapable: { type: 'boolean', required: true },
          diagnostics: { type: 'json' },
        },
      },
      render: (_args, value) => {
        const text = (value.savedPath === undefined
          ? `Screenshot of ${value.path} attached (${value.width}x${value.height} px).`
          : `Screenshot of ${value.path} saved to ${value.savedPath} (${value.width}x${value.height} px).`)
          + (value.diagnostics === null || value.diagnostics === undefined
            ? ''
            : `\nviewer diagnostics: ${JSON.stringify(value.diagnostics)}`);
        return value.imageCapable
          ? [{ type: 'text', text }, { type: 'image', attachment: value.attachment as unknown as ImageAttachmentRef }]
          : [{ type: 'text', text }];
      },
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const scene = requireScene(options, agent, args.tab, 'capturing')
      const delivery = await options.hub.wait(agent.id, String(exec.callId), options.captureTimeoutMs, exec.signal)
      const ref = delivery.ref
      const savedPath = await persistCapture(ctx, agent, ref, exec.signal)
      return {
        attachment: ref as never,
        width: ref.width,
        height: ref.height,
        path: scene.path,
        ...(savedPath === undefined ? {} : { savedPath }),
        imageCapable: await isImageCapable(ctx, exec),
        ...(delivery.report === undefined ? {} : { diagnostics: delivery.report as never }),
      }
    },
  }))
}

function requireScene(
  options: MolToolOptions,
  agent: Agent,
  tab: string | undefined,
  action: string,
): MolSceneState {
  const scene = options.sceneOf(agent.session, tab)
  if (scene !== undefined) return scene
  throw new ToolArgsError([
    tab === undefined
      ? `open a structure with mol_open before ${action}`
      : `no tab page for ${tab}; call mol_open or omit tab to use the active page`,
  ])
}

async function persistCapture(
  ctx: Context,
  agent: Agent,
  ref: ImageAttachmentRef,
  signal: AbortSignal,
): Promise<string | undefined> {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) return undefined
  try {
    const stored = await attachments.readImage(ref, signal)
    const cwd = await ctx.workingDirectory.ensure(agent, signal)
    const directory = join(cwd, '.mol4agent', 'captures')
    await mkdir(directory, { recursive: true })
    const file = join(directory, captureFileName(ref.attachmentId, Date.now()))
    await writeFile(file, stored.data)
    return file
  } catch (reason) {
    console.warn('[mol4agent] could not save the screenshot', reason)
    return undefined
  }
}

async function isImageCapable(ctx: Context, exec: ToolRunContext): Promise<boolean> {
  const llm = ctx.get('llm')
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  if (llm === undefined || provider === undefined || model === undefined) return false
  try {
    const info = await llm.resolveModelInfo(provider, model, exec.signal)
    return info.inputModalities?.includes('image') === true
  } catch {
    return false
  }
}

function requireAgent(exec: ToolRunContext): Agent {
  if (exec.agent === undefined) throw new ToolContextUnavailableError('molecule tools require an agent Session')
  return exec.agent
}

const MEASUREMENT_KINDS = new Set(['chain', 'residue', 'residues', 'comp', 'schema'])

function assertMeasurementSelector(value: unknown): void {
  let selector
  try {
    selector = normalizeSelector(value)
  } catch (error) {
    throw new ToolArgsError([error instanceof Error ? error.message : String(error), SELECTOR_HELP])
  }
  if (!MEASUREMENT_KINDS.has(selector.kind)) {
    throw new ToolArgsError([
      'measure targets must be chain/residue/residues/comp/schema selectors',
      `received ${selector.kind}; semantic categories have no single atom position`,
    ])
  }
}

function assertSelector(value: unknown): void {
  try {
    normalizeSelector(value)
  } catch (error) {
    throw new ToolArgsError([error instanceof Error ? error.message : String(error), SELECTOR_HELP])
  }
}

/** A structure selector or one of the live viewer selections an inspection accepts. */
function assertInspectTarget(value: unknown): void {
  if (typeof value === 'object' && value !== null) {
    const kind = (value as { kind?: unknown }).kind
    if (kind === 'selection' || kind === 'focus') return
  }
  assertSelector(value)
}

function assertColorParams(value: unknown): void {
  if (typeof value !== 'object' || value === null) throw new ToolArgsError(['colorParams must be an object like {"value": 16711680}'])
  const candidate = value as Record<string, unknown>
  if (candidate.value !== undefined) {
    try {
      parseColor(candidate.value)
    } catch (error) {
      throw new ToolArgsError([error instanceof Error ? error.message : String(error)])
    }
  }
}

/** Resolved `#rrggbb` for a validated colorParams object, when it carries a value. */
function resolvedColorOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Record<string, unknown>
  if (candidate.value === undefined) return undefined
  return formatColor(parseColor(candidate.value))
}

function formatInterface(label: string, result: InterfaceResult): string {
  if (result.residues.length === 0) {
    return `No interface residues within ${result.cutoff} A for ${label}.`
  }
  const ranges = result.ranges.map(range => range.start === range.end
    ? `chain ${range.chain}: ${range.start}`
    : `chain ${range.chain}: ${range.start}-${range.end}`)
  return `Interface of ${label} at ${result.cutoff} A: ${result.residues.length} residues, ${result.ranges.length} ranges (${result.contactPairs} residue pairs).\n`
    + ranges.map(line => `- ${line}`).join('\n')
    + `\n\nStyle an interface range with mol_style target {\"kind\":\"residues\",\"chain\":\"A\",\"start\":26,\"end\":33}.\n`
    + `JSON: ${JSON.stringify({ cutoff: result.cutoff, residues: result.residues, ranges: result.ranges })}`
}

function describeSelector(value: unknown): string {
  try {
    const selector = normalizeSelector(value)
    switch (selector.kind) {
      case 'chain': return `chain ${selector.chain}`
      case 'residue': return `residue ${selector.chain ?? ''}${selector.index}`.trim()
      case 'residues': return `residues ${selector.chain ?? ''}${selector.start}-${selector.end}`.trim()
      case 'comp': return `residues named ${selector.compId}`
      default: return selector.kind
    }
  } catch {
    return 'the selection'
  }
}

function describeFile(file: ResolvedMoleculeFile): string {
  const head = `<structure path="${escapeAttribute(canonicalTabPath(file.absolutePath))}" format="${file.format}" bytes="${file.bytes.byteLength}">`
  let summary: StructureSummary
  try {
    summary = summarizeStructure({ data: file.bytes, format: file.format, label: file.label })
  } catch {
    return `${head}\n(summary unavailable for this format; the viewer can still render it)\n</structure>`
  }
  const chains = summary.chains.length === 0
    ? '(none)'
    : summary.chains
      .map(chain => `- ${chain.id}: ${chain.kind}, ${chain.residues} residues, ${chain.atoms} atoms${chain.compIds.length === 0 ? '' : ` [${chain.compIds.join(', ')}]`}`)
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

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

