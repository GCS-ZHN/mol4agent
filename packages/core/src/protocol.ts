/**
 * Harness-neutral protocol of @gcszhn/mol4agent-core.
 *
 * Core only ever receives bytes plus an explicit content format. Which file a
 * harness opened, how it obtained the bytes, and how it decided that a `.pdb`
 * file is `format: 'pdb'` are all adapter concerns. DSH can obtain a path and
 * read it with its own API; Codex-style preview surfaces hand raw data. Both
 * arrive here as the same `StructureData`.
 *
 * @module @gcszhn/mol4agent-core/protocol
 */

/** Structure formats core can render. Detection of these is the adapter's job. */
export const MOL_FORMATS = [
  'pdb',
  'pdbqt',
  'pqr',
  'mmcif',
  'bcif',
  'mol',
  'sdf',
  'mol2',
  'xyz',
  'gro',
] as const

export type MolFormat = (typeof MOL_FORMATS)[number]

/** Preset names exposed to agents. Adapters may also pass a registered custom preset by name. */
export const PRESETS = ['default', 'auto', 'illustrative', 'atomic-detail', 'polymer-and-ligand'] as const

export type PresetName = (typeof PRESETS)[number]

/** Representation types known to be useful for agent-driven views. */
export const REPRESENTATION_TYPES = [
  'cartoon',
  'ball-and-stick',
  'licorice',
  'spacefill',
  'line',
  'point',
  'surface',
  'gaussian-surface',
  'molecular-surface',
] as const

export type RepresentationType = (typeof REPRESENTATION_TYPES)[number]

/** Colour themes known to be useful for agent-driven views. */
export const COLOR_THEMES = [
  'chain-id',
  'element-symbol',
  'residue-name',
  'uniform',
  'secondary-structure',
  'entity-id',
  'molecule-type',
  'hydrophobicity',
] as const

export type ColorTheme = (typeof COLOR_THEMES)[number]

/**
 * Bytes plus the explicit format the adapter selected for them.
 *
 * `data` may be text (PDB, mmCIF, SDF, ...) or binary (BCIF). `label` is a
 * display string chosen by the adapter; core never derives it from a path.
 */
export interface StructureData {
  readonly data: string | Uint8Array
  readonly format: MolFormat
  /** Whether `data` is binary. Adapters decide from their own metadata. */
  readonly binary?: boolean
  readonly label?: string
}

/** A style applied to one structure or one selection inside it. */
export interface StyleSpec {
  readonly type?: RepresentationType
  readonly color?: ColorTheme
  readonly colorParams?: { readonly value?: string | number }
  readonly quality?: 'low' | 'medium' | 'high' | 'auto'
}

/** Low-level escape hatch: a subset of Mol*'s `StructureElement.Schema`. */
export interface ElementSchema {
  readonly auth_asym_id?: string
  readonly label_asym_id?: string
  readonly auth_seq_id?: number
  readonly label_seq_id?: number
  readonly label_comp_id?: string
  readonly auth_comp_id?: string
  readonly beg_auth_seq_id?: number
  readonly end_auth_seq_id?: number
  readonly beg_label_seq_id?: number
  readonly end_label_seq_id?: number
  readonly label_atom_id?: string
  readonly auth_atom_id?: string
  readonly type_symbol?: string
}

/**
 * A selection an agent can express without knowing atom indices.
 *
 * Adapters pass these through unchanged; core compiles them to Mol* selection
 * queries or schemas. This shape is the stable part of the agent-facing
 * contract, so adding a variant is a protocol change.
 */
export type StructureSelector =
  | { readonly kind: 'all' }
  | { readonly kind: 'polymer' }
  | { readonly kind: 'protein' }
  | { readonly kind: 'nucleic' }
  | { readonly kind: 'ligand' }
  | { readonly kind: 'water' }
  | { readonly kind: 'ion' }
  | { readonly kind: 'chain'; readonly chain: string }
  | { readonly kind: 'residue'; readonly chain?: string; readonly index: number; readonly auth?: boolean }
  | { readonly kind: 'residues'; readonly chain?: string; readonly start: number; readonly end: number; readonly auth?: boolean }
  | { readonly kind: 'comp'; readonly compId: string }
  | { readonly kind: 'schema'; readonly schema: ElementSchema }

/**
 * One replayable viewer command.
 *
 * Loading is a method, not a command: bytes are adapter-owned input and may not
 * be serializable (Codex). Commands only describe changes to an already-loaded
 * structure, so an adapter can store them in a session log and replay them.
 */
export type MolCommand =
  | { readonly op: 'represent'; readonly style: StyleSpec; readonly target?: StructureSelector }
  | {
    readonly op: 'select'
    readonly target: StructureSelector
    readonly mode?: 'select' | 'highlight'
    readonly focus?: boolean
  }
  | { readonly op: 'clear-selection'; readonly mode?: 'select' | 'highlight' }
  | { readonly op: 'focus'; readonly target?: StructureSelector }
  | { readonly op: 'camera'; readonly action: 'reset' }
  | { readonly op: 'background'; readonly color: string | 'theme' }
  | {
    readonly op: 'measure'
    readonly kind: 'distance' | 'angle' | 'dihedral'
    readonly targets: readonly StructureSelector[]
  }
  | { readonly op: 'label'; readonly target: StructureSelector; readonly text?: string }

export type Mol4AgentErrorCode =
  | 'INVALID_COMMAND'
  | 'UNSUPPORTED_FORMAT'
  | 'UNSUPPORTED_REPRESENTATION'
  | 'REPRESENT_FAILED'
  | 'NO_STRUCTURE'
  | 'LOAD_FAILED'
  | 'CAPTURE_FAILED'
  | 'SUMMARY_UNSUPPORTED'
  | 'DISPOSED'

/** Structured failure. Tools turn this into model-facing text instead of a stack trace. */
export class Mol4AgentError extends Error {
  readonly code: Mol4AgentErrorCode

  constructor(code: Mol4AgentErrorCode, message: string) {
    super(message)
    this.name = 'Mol4AgentError'
    this.code = code
  }
}

export type CommandResult =
  | {
    readonly ok: true
    readonly op: MolCommand['op']
    readonly message?: string
    readonly data?: unknown
  }
  | {
    readonly ok: false
    readonly op: MolCommand['op']
    readonly code: Mol4AgentErrorCode
    readonly message: string
  }

/** One chain-level row of a structure summary. */
export interface ChainSummary {
  readonly id: string
  readonly kind: 'polymer' | 'ligand' | 'water' | 'ion' | 'other'
  readonly atoms: number
  readonly residues: number
  readonly compIds: readonly string[]
}

/** Format-agnostic description of a structure, produced before or after loading. */
export interface StructureSummary {
  readonly format: MolFormat
  readonly label?: string
  readonly title?: string
  readonly atomCount: number
  readonly residueCount: number
  readonly modelCount: number
  readonly chains: readonly ChainSummary[]
  readonly ligands: readonly { readonly compId: string; readonly count: number }[]
  /** False when the adapter's format can be rendered but not summarized from bytes (e.g. BCIF). */
  readonly complete: boolean
}

export interface CaptureOptions {
  readonly width?: number
  readonly height?: number
  readonly transparent?: boolean
  readonly background?: string
}

/** Narrow a parsed JSON value to a command op without validating every field. */
export function isMolCommandOp(value: unknown): value is MolCommand['op'] {
  return typeof value === 'string' && COMMAND_OPS.has(value as MolCommand['op'])
}

const COMMAND_OPS = new Set<MolCommand['op']>([
  'represent',
  'select',
  'clear-selection',
  'focus',
  'camera',
  'background',
  'measure',
  'label',
])

export function isMolFormat(value: unknown): value is MolFormat {
  return typeof value === 'string' && (MOL_FORMATS as readonly string[]).includes(value)
}

export function isPresetName(value: unknown): value is PresetName {
  return typeof value === 'string' && (PRESETS as readonly string[]).includes(value)
}

export function isStructureData(value: unknown): value is StructureData {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { data?: unknown; format?: unknown }
  if (!isMolFormat(candidate.format)) return false
  return typeof candidate.data === 'string' || candidate.data instanceof Uint8Array
}
