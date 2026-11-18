/**
 * Pure helpers for the `mol_*` tools: style normalization, selector
 * description/validation, and the human-readable structure summary. No OpenCode
 * or filesystem imports; everything here is testable in isolation.
 *
 * @module @gcszhn/mol4agent-opencode/tools
 */
import {
  COLOR_THEMES,
  REPRESENTATION_TYPES,
  formatColor,
  parseColor,
  type AlignmentResult,
  type InspectTarget,
  type MolFormat,
  type StyleSpec,
  type TmScoreResult,
  type StructureSelector,
  type StructureSummary,
} from '@gcszhn/mol4agent-core/protocol'
import { summarizeStructure } from '@gcszhn/mol4agent-core/parse'
import type { InterfaceResult } from './interface.ts'
import type { ResolvedMoleculeFile } from './paths.ts'
import { normalizeSelector } from './selector.ts'

/** Human description used by selector-shaped tool arguments. */
export const SELECTOR_DESCRIPTION =
  'A StructureSelector object. Examples: {"kind":"ligand"}, {"kind":"protein"}, '
  + '{"kind":"chain","chain":"A"}, {"kind":"residues","chain":"A","start":10,"end":25}, '
  + '{"kind":"residue","chain":"A","index":42}, {"kind":"comp","compId":"ATP"}. '
  + 'Add "structureId" to target one structure when several are loaded.'

/** Optional structure scope every selector variant accepts. */
const STRUCTURE_SCOPE_SCHEMA = {
  structureId: {
    type: 'string',
    description: 'Structure id from mol_open (primary is "structure") or mol_add_structure. '
      + 'Omit to target every loaded structure.',
  },
}

/** JSON Schema for a StructureSelector (used by the tool input schemas). */
export const SELECTOR_SCHEMA = {
  oneOf: [
    { type: 'object', properties: { kind: { enum: ['all'] }, ...STRUCTURE_SCOPE_SCHEMA }, required: ['kind'], additionalProperties: false },
    { type: 'object', properties: { kind: { enum: ['polymer'] }, ...STRUCTURE_SCOPE_SCHEMA }, required: ['kind'], additionalProperties: false },
    { type: 'object', properties: { kind: { enum: ['protein'] }, ...STRUCTURE_SCOPE_SCHEMA }, required: ['kind'], additionalProperties: false },
    { type: 'object', properties: { kind: { enum: ['nucleic'] }, ...STRUCTURE_SCOPE_SCHEMA }, required: ['kind'], additionalProperties: false },
    { type: 'object', properties: { kind: { enum: ['ligand'] }, ...STRUCTURE_SCOPE_SCHEMA }, required: ['kind'], additionalProperties: false },
    { type: 'object', properties: { kind: { enum: ['water'] }, ...STRUCTURE_SCOPE_SCHEMA }, required: ['kind'], additionalProperties: false },
    { type: 'object', properties: { kind: { enum: ['ion'] }, ...STRUCTURE_SCOPE_SCHEMA }, required: ['kind'], additionalProperties: false },
    {
      type: 'object',
      properties: { kind: { enum: ['chain'] }, ...STRUCTURE_SCOPE_SCHEMA, chain: { type: 'string', minLength: 1 } },
      required: ['kind', 'chain'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { kind: { enum: ['residue'] }, ...STRUCTURE_SCOPE_SCHEMA, chain: { type: 'string' }, index: { type: 'integer' }, auth: { type: 'boolean' } },
      required: ['kind', 'index'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { kind: { enum: ['residues'] }, ...STRUCTURE_SCOPE_SCHEMA, chain: { type: 'string' }, start: { type: 'integer' }, end: { type: 'integer' }, auth: { type: 'boolean' } },
      required: ['kind', 'start', 'end'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { kind: { enum: ['comp'] }, ...STRUCTURE_SCOPE_SCHEMA, compId: { type: 'string', minLength: 1 } },
      required: ['kind', 'compId'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { kind: { enum: ['schema'] }, ...STRUCTURE_SCOPE_SCHEMA, schema: { type: 'object' } },
      required: ['kind', 'schema'],
      additionalProperties: false,
    },
  ],
}

/**
 * JSON Schema for an inspection target: any structure selector plus the two
 * live viewer states only Mol* knows (`selection`, `focus`).
 */
export const INSPECT_TARGET_SCHEMA = {
  oneOf: [
    ...SELECTOR_SCHEMA.oneOf,
    { type: 'object', properties: { kind: { enum: ['selection'] } }, required: ['kind'], additionalProperties: false },
    { type: 'object', properties: { kind: { enum: ['focus'] } }, required: ['kind'], additionalProperties: false },
  ],
}

/** JSON Schema fields for the style parameters shared by mol_open/mol_style. */
export const STYLE_SCHEMA = {
  type: { enum: REPRESENTATION_TYPES },
  color: { enum: COLOR_THEMES },
  colorParams: {
    type: 'object',
    description:
      'Optional color theme params. colorParams.value applies only to color "uniform" and accepts '
      + 'a CSS name ("red"), hex ("#ff0000"), or a 24-bit integer (16711680).',
    properties: { value: { description: 'Color value; invalid values are rejected.' } },
    additionalProperties: false,
  },
}

export const MEASUREMENT_KINDS = new Set(['chain', 'residue', 'residues', 'comp', 'schema'])

/** Read the optional `tab` argument (an absolute path) from a tool call. */
export function tabOf(input: unknown): string | undefined {
  const value = (input as { tab?: unknown } | null | undefined)?.tab
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Build a StyleSpec from the optional type/color/colorParams fields. */
export function styleOf(args: {
  readonly type?: StyleSpec['type']
  readonly color?: StyleSpec['color']
  readonly colorParams?: { readonly value?: string | number }
}): StyleSpec {
  const style: {
    type?: StyleSpec['type']
    color?: StyleSpec['color']
    colorParams?: { value: number }
  } = {}
  if (args.type !== undefined) style.type = args.type
  if (args.color !== undefined) style.color = args.color
  if (args.colorParams?.value !== undefined) {
    // Normalize once here so the scene log and core both see a 24-bit value;
    // an invalid colour throws before any scene command is appended.
    style.colorParams = { value: parseColor(args.colorParams.value) }
  }
  return Object.keys(style).length === 0 ? { type: 'cartoon', color: 'chain-id' } : style
}

/** Validate an agent-supplied colorParams object (shape plus parseable value). */
export function assertColorParams(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('colorParams must be an object like {"value": 16711680}')
  }
  const candidate = value as Record<string, unknown>
  if (candidate.value !== undefined) parseColor(candidate.value)
}

/** Resolved `#rrggbb` for a validated colorParams object, when it carries a value. */
export function resolvedColorOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Record<string, unknown>
  if (candidate.value === undefined) return undefined
  return formatColor(parseColor(candidate.value))
}

export function describeStyle(args: {
  readonly type?: StyleSpec['type']
  readonly color?: StyleSpec['color']
  readonly colorParams?: { readonly value?: string | number }
  readonly target?: unknown
  readonly replace?: boolean
}): string {
  const color = resolvedColorOf(args.colorParams)
  const style = [args.type ?? 'cartoon', args.color ?? 'chain-id'].join(' / ')
    + (color === undefined ? '' : ` ${color}`)
    + (args.replace === false ? ' (overlaid)' : '')
  if (args.target === undefined) return `Applied ${style} to the whole structure.`
  return `Applied ${style} to ${describeSelector(normalizeSelector(args.target))}.`
}

export function describeSelector(value: { readonly kind: string } & Record<string, unknown>): string {
  switch (value.kind) {
    case 'chain': return `chain ${String(value.chain)}`
    case 'residue': return `residue ${String(value.chain ?? '')}${String(value.index)}`.trim()
    case 'residues': return `residues ${String(value.chain ?? '')}${String(value.start)}-${String(value.end)}`.trim()
    case 'comp': return `residues named ${String(value.compId)}`
    default: return value.kind
  }
}

/** Human-readable summary of a resolved file (never dumps the raw structure). */
export function describeFile(file: ResolvedMoleculeFile): string {
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

export function summarizeSafely(bytes: Uint8Array, format: MolFormat): StructureSummary | undefined {
  try {
    return summarizeStructure({ data: bytes, format })
  } catch {
    return undefined
  }
}

/** Model-facing summary of one alignment command result. */
export function formatAlignment(result: AlignmentResult): string {
  const method = result.method === 'tm-align' ? 'TM-align' : 'sequence alignment'
  const score = result.tmScoreA === undefined
    ? `RMSD ${result.rmsd.toFixed(2)} A over ${result.alignedLength} aligned atoms`
    : `TM-score ${result.tmScoreA.toFixed(4)}/${result.tmScoreB?.toFixed(4) ?? 'n/a'}, `
      + `RMSD ${result.rmsd.toFixed(2)} A, ${result.alignedLength} aligned residues`
  return `Aligned ${result.target} onto ${result.reference} (${method}): ${score}.`
}

/** Model-facing summary of one read-only TM-score query. */
export function formatTmScore(result: TmScoreResult): string {
  return `TM-score ${result.tmScoreA.toFixed(4)}/${result.tmScoreB.toFixed(4)}, `
    + `RMSD ${result.rmsd.toFixed(2)} A, ${result.alignedLength} aligned residues `
    + `(reference ${result.reference}: ${result.referenceAtoms} trace atoms; `
    + `target ${result.target}: ${result.targetAtoms} trace atoms).`
}

export function formatInterface(label: string, result: InterfaceResult): string {
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

export function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

/** Validate a selector against the open scene's parsed summary. */
export function validateSelectorAgainst(
  summary: StructureSummary | undefined,
  bytes: Uint8Array,
  format: MolFormat,
  selector: StructureSelector,
): void {
  if (summary === undefined || !summary.complete) return
  const chains = summary.chains.map(chain => chain.id)
  const chainList = chains.length === 0 ? '(none)' : chains.join(', ')
  switch (selector.kind) {
    case 'chain':
      if (!chains.includes(selector.chain)) {
        throw new Error(`chain "${selector.chain}" does not exist; available chains: ${chainList}`)
      }
      return
    case 'comp': {
      const components = [...new Set([
        ...summary.chains.flatMap(chain => chain.compIds),
        ...summary.ligands.map(ligand => ligand.compId),
      ])]
      if (components.includes(selector.compId)) return
      // `ChainSummary.compIds` is a display list capped at 12 entries, so an
      // absent polymer component proves nothing once a chain is saturated. Do
      // not reject a valid target just because the summary hid it.
      if (summary.chains.some(chain => chain.compIds.length >= 12)) return
      throw new Error(
        `component "${selector.compId}" does not exist; available components: `
        + `${components.length === 0 ? '(none)' : components.join(', ')}`,
      )
    }
    case 'residue':
    case 'residues': {
      if (selector.chain !== undefined && !chains.includes(selector.chain)) {
        throw new Error(`chain "${selector.chain}" does not exist; available chains: ${chainList}`)
      }
      if (selector.kind === 'residue') {
        validateResidueRange(bytes, format, selector.chain, selector.index, selector.index)
      } else {
        validateResidueRange(bytes, format, selector.chain, selector.start, selector.end)
      }
      return
    }
    default:
      return
  }
}

function validateResidueRange(
  bytes: Uint8Array,
  format: MolFormat,
  chain: string | undefined,
  start: number,
  end: number,
): void {
  const extent = residueExtent(bytes, format, chain)
  if (extent === undefined) return
  const label = chain === undefined ? 'structure' : `chain ${chain}`
  if (end < extent.min || start > extent.max) {
    throw new Error(
      `residues ${String(start)}-${String(end)} do not intersect ${label} `
      + `(parsed residue range ${String(extent.min)}-${String(extent.max)})`,
    )
  }
}

function residueExtent(
  bytes: Uint8Array,
  format: MolFormat,
  chain: string | undefined,
): { readonly min: number; readonly max: number } | undefined {
  if (format !== 'pdb' && format !== 'pdbqt' && format !== 'pqr') return undefined
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const line of text.split(/\r?\n/u)) {
    if (!line.startsWith('ATOM  ') && !line.startsWith('HETATM')) continue
    if (chain !== undefined && (line[21] ?? '') !== chain) continue
    const index = Number.parseInt(line.slice(22, 26).trim(), 10)
    if (!Number.isFinite(index)) continue
    if (index < min) min = index
    if (index > max) max = index
  }
  return Number.isFinite(min) ? { min, max } : undefined
}
