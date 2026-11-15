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
  REPRESENTATION_TYPES,
  type StructureSummary,
} from '@gcszhn/mol4agent-core/protocol'
import { summarizeStructure } from '@gcszhn/mol4agent-core/parse'
import { normalizeSelector } from '../selector.ts'
import type { MolSessionState } from '../state.ts'
import type { CaptureHub } from './capture.ts'
import { findInterfaceResidues, type InterfaceResult } from './interface.ts'
import { resolveMoleculeFile, type ResolvedMoleculeFile } from './paths.ts'

export interface MolToolOptions {
  readonly hub: CaptureHub
  /** Read the current scene from the registered projection. */
  readonly sceneOf: (session: Session) => MolSessionState
  readonly maxFileBytes: number
  readonly captureTimeoutMs: number
  readonly captureWidth: number
  readonly captureHeight: number
}

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
    name: 'mol_open',
    description: 'Open a molecular structure in the right-sidebar viewer and make it the active agent scene. '
      + 'The page opens automatically. Optionally set the representation/color and highlight a selection.',
    parameters: {
      path: { type: 'string', required: true, description: 'Structure file path, absolute or relative to the session working directory.' },
      type: { type: 'string', enum: REPRESENTATION_TYPES, description: 'Representation type. Defaults to cartoon.' },
      color: { type: 'string', enum: COLOR_THEMES, description: 'Color theme. Defaults to chain-id.' },
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
      return `${describeFile(file)}\n\n<viewer>Opened in the sidebar preview. Use mol_style, mol_select, mol_measure, or mol_capture to operate it.</viewer>`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mol_style',
    description: 'Change the representation or color theme of the active molecular viewer scene. '
      + 'Without target this replaces the current representation; with target it adds a representation to that selection.',
    parameters: {
      type: { type: 'string', enum: REPRESENTATION_TYPES, description: 'Representation type, e.g. cartoon or ball-and-stick.' },
      color: { type: 'string', enum: COLOR_THEMES, description: 'Color theme, e.g. chain-id, element-symbol, residue-name.' },
      target: { type: 'json', description: `Optional selection to style additively; the rest of the structure keeps its representation. ${SELECTOR_HELP}` },
      colorParams: { type: 'json', description: 'Optional color theme params. For a uniform color pass {"value": 16711680} (0xff0000).' },
    },
    isConcurrencySafe: () => false,
    output: {
      schema: { type: 'string' },
      render: (_args, text) => [{ type: 'text', text }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const scene = options.sceneOf(agent.session).scene
      if (scene === null) throw new ToolArgsError(['open a structure with mol_open before styling it'])
      if (args.target !== undefined) assertSelector(args.target)
      if (args.colorParams !== undefined) assertColorParams(args.colorParams)
      const style = [args.type ?? 'cartoon', args.color ?? 'chain-id'].join(' / ')
      const scope = args.target === undefined ? scene.label : `${scene.label} (${describeSelector(args.target)})`
      return `Applied ${style} to ${scope}.`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mol_select',
    description: 'Select, highlight, or focus part of the active structure. '
      + 'Use a StructureSelector; the selection is rendered in the open viewer.',
    parameters: {
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
      const scene = options.sceneOf(agent.session).scene
      if (scene === null) throw new ToolArgsError(['open a structure with mol_open before selecting'])
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
      target: { type: 'json', description: `Optional selection to focus. ${SELECTOR_HELP}` },
    },
    isConcurrencySafe: () => false,
    output: {
      schema: { type: 'string' },
      render: (_args, text) => [{ type: 'text', text }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const scene = options.sceneOf(agent.session).scene
      if (scene === null) throw new ToolArgsError(['open a structure with mol_open before focusing'])
      if (args.target !== undefined) assertSelector(args.target)
      return args.target === undefined
        ? `Focused ${scene.label}.`
        : `Focused ${describeSelector(args.target)} in ${scene.label}.`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mol_measure',
    description: 'Add a distance, angle, or dihedral measurement between exactly 2/3/4 selections in the active viewer. '
      + 'Use chain/residue/residues/comp/schema selectors, not semantic categories or raw coordinates.',
    parameters: {
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
      const scene = options.sceneOf(agent.session).scene
      if (scene === null) throw new ToolArgsError(['open a structure with mol_open before measuring'])
      const needed = args.kind === 'distance' ? 2 : args.kind === 'angle' ? 3 : 4
      if (args.targets.length !== needed) {
        throw new ToolArgsError([`${args.kind} needs exactly ${needed} targets, received ${args.targets.length}`])
      }
      for (const target of args.targets) assertMeasurementSelector(target)
      return `Added a ${args.kind} measurement to ${scene.label}.`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mol_capture',
    description: 'Capture the current molecular viewer viewport as a PNG and attach it to this tool result. '
      + 'Use it to visually verify a view or show a figure to the user.',
    parameters: {
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
      const scene = options.sceneOf(agent.session).scene
      if (scene === null) throw new ToolArgsError(['open a structure with mol_open before capturing'])
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
    const file = join(directory, `mol4agent-${Date.now()}-${String(ref.attachmentId).slice(0, 8)}.png`)
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

function assertColorParams(value: unknown): void {
  if (typeof value !== 'object' || value === null) throw new ToolArgsError(['colorParams must be an object like {"value": 16711680}'])
  const candidate = value as Record<string, unknown>
  if (candidate.value !== undefined && typeof candidate.value !== 'number' && typeof candidate.value !== 'string') {
    throw new ToolArgsError(['colorParams.value must be a number or a color string'])
  }
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

