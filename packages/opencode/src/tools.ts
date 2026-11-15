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
  type MolFormat,
  type StyleSpec,
  type StructureSelector,
  type StructureSummary,
} from '@gcszhn/mol4agent-core/protocol'
import { summarizeStructure } from '@gcszhn/mol4agent-core/parse'
import type { InterfaceResult } from './interface.ts'
import type { ResolvedMoleculeFile } from './paths.ts'
import { normalizeSelector } from './selector.ts'

/** JSON Schema for a StructureSelector (used by the tool input schemas). */
export const SELECTOR_SCHEMA = {
  oneOf: [
    { type: 'object', properties: { kind: { enum: ['all'] } }, required: ['kind'], additionalProperties: false },
    { type: 'object', properties: { kind: { enum: ['polymer'] } }, required: ['kind'], additionalProperties: false },
    { type: 'object', properties: { kind: { enum: ['protein'] } }, required: ['kind'], additionalProperties: false },
    { type: 'object', properties: { kind: { enum: ['nucleic'] } }, required: ['kind'], additionalProperties: false },
    { type: 'object', properties: { kind: { enum: ['ligand'] } }, required: ['kind'], additionalProperties: false },
    { type: 'object', properties: { kind: { enum: ['water'] } }, required: ['kind'], additionalProperties: false },
    { type: 'object', properties: { kind: { enum: ['ion'] } }, required: ['kind'], additionalProperties: false },
    {
      type: 'object',
      properties: { kind: { enum: ['chain'] }, chain: { type: 'string', minLength: 1 } },
      required: ['kind', 'chain'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { kind: { enum: ['residue'] }, chain: { type: 'string' }, index: { type: 'integer' }, auth: { type: 'boolean' } },
      required: ['kind', 'index'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { kind: { enum: ['residues'] }, chain: { type: 'string' }, start: { type: 'integer' }, end: { type: 'integer' }, auth: { type: 'boolean' } },
      required: ['kind', 'start', 'end'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { kind: { enum: ['comp'] }, compId: { type: 'string', minLength: 1 } },
      required: ['kind', 'compId'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { kind: { enum: ['schema'] }, schema: { type: 'object' } },
      required: ['kind', 'schema'],
      additionalProperties: false,
    },
  ],
}

/** JSON Schema fields for the style parameters shared by mol_open/mol_style. */
export const STYLE_SCHEMA = {
  type: { enum: REPRESENTATION_TYPES },
  color: { enum: COLOR_THEMES },
  colorParams: {
    type: 'object',
    properties: { value: {} },
    additionalProperties: false,
  },
}

export const MEASUREMENT_KINDS = new Set(['chain', 'residue', 'residues', 'comp', 'schema'])

/** Build a StyleSpec from the optional type/color/colorParams fields. */
export function styleOf(args: {
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

export function describeStyle(args: {
  readonly type?: StyleSpec['type']
  readonly color?: StyleSpec['color']
  readonly target?: unknown
}): string {
  const style = [args.type ?? 'cartoon', args.color ?? 'chain-id'].join(' / ')
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
      if (!components.includes(selector.compId)) {
        throw new Error(
          `component "${selector.compId}" does not exist; available components: `
          + `${components.length === 0 ? '(none)' : components.join(', ')}`,
        )
      }
      return
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
