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

/** Alignment algorithms exposed to agents. */
export const ALIGNMENT_METHODS = ['tm-align', 'sequence'] as const

export type AlignmentMethod = (typeof ALIGNMENT_METHODS)[number]

/**
 * Stable identifier for one structure in a viewer scene.
 *
 * IDs are deliberately URL/JSON friendly so they can travel through every
 * adapter and be echoed by a model: 1-64 characters, starting with a letter or
 * digit, then letters, digits, `.`, `_` or `-`.
 */
export const STRUCTURE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function isStructureId(value: unknown): value is string {
  return typeof value === 'string' && STRUCTURE_ID_PATTERN.test(value)
}

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

/** Fields that scope a selector to one structure in a multi-structure scene. */
export type StructureSelectorScope = {
  /**
   * Structure id returned by `load`/`addStructure` (or the adapters' tools).
   * Omitted means "every loaded structure", matching single-structure scenes.
   */
  readonly structureId?: string
}

type StructureSelectorBody =
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
 * A selection an agent can express without knowing atom indices.
 *
 * Adapters pass these through unchanged; core compiles them to Mol* selection
 * queries or schemas. This shape is the stable part of the agent-facing
 * contract, so adding a variant is a protocol change. `structureId` disambiguates
 * chains with the same id in different loaded structures.
 */
export type StructureSelector = StructureSelectorBody & StructureSelectorScope

/**
 * How much detail one inspection returns.
 *
 * `summary` reports totals, per-component counts, and styles but no rows;
 * `residues` adds residue rows, and `atoms` adds per-atom rows inside them.
 */
export const INSPECT_DETAILS = ['summary', 'residues', 'atoms'] as const

export type InspectDetail = (typeof INSPECT_DETAILS)[number]

/** Row budget for one inspection result; counts always cover the full target. */
export const DEFAULT_INSPECT_LIMIT = 200

/**
 * What an inspection describes.
 *
 * Selectors name structure content; `selection` and `focus` name the viewer's
 * live state, which only Mol* knows: `selection` is the selection manager
 * (what a human selected by clicking, or what `mol_select` set) and `focus` is
 * the structure focus entry the Mol* UI keeps for the last clicked location.
 */
export type InspectTarget =
  | StructureSelector
  | { readonly kind: 'selection' }
  | { readonly kind: 'focus' }

/**
 * One read-only query about the loaded structure and the way Mol* draws it.
 *
 * Unlike {@link MolCommand} this changes nothing and is never replayed: it
 * samples the viewer as it is right now, so answers include human-driven
 * changes (clicked selection, panel styles) that never reached the session log.
 */
export interface InspectRequest {
  /** Defaults to the whole structure. */
  readonly target?: InspectTarget
  /** Defaults to `summary`. */
  readonly detail?: InspectDetail
  /** Maximum residue rows to return. Defaults to {@link DEFAULT_INSPECT_LIMIT}. */
  readonly limit?: number
}

/** Coarse classification shared with {@link ChainSummary}. */
export type InspectKind = 'polymer' | 'ligand' | 'water' | 'ion' | 'other'

export interface InspectVector {
  readonly x: number
  readonly y: number
  readonly z: number
}

/** One atom as Mol* currently places it. */
export interface InspectAtom extends InspectVector {
  readonly name: string
  readonly element: string
  readonly occupancy?: number
  readonly bFactor?: number
  readonly altId?: string
}

/** One residue as Mol* currently models it, with its drawn centre. */
export interface InspectResidue extends InspectVector {
  readonly chain: string
  readonly seqId: number
  readonly labelSeqId: number
  readonly compId: string
  readonly kind: InspectKind
  readonly atoms: number
  /** Present when the request asked for `atoms` detail. */
  readonly atomRows?: readonly InspectAtom[]
}

/** Where an overlay that changes the drawn colour comes from. */
export type InspectOverlaySource = 'selection' | 'overpaint'

/**
 * One colour layer drawn on top of a representation's own theme colour.
 *
 * `selection` is the canvas marker that tints selected elements (colour and
 * strength come from `canvas3d.props.renderer`); `overpaint` is a per-region
 * colour override stored as a transform on the representation.
 */
export interface InspectOverlay {
  readonly source: InspectOverlaySource
  /** Colour the overlay paints with, as `#rrggbb`. */
  readonly color?: string
  /** Blend strength when the overlay mixes with the colour below it instead of replacing it. */
  readonly strength?: number
  /** What the overlay is applied to, e.g. the representation type or a selection entry. */
  readonly label?: string
  /** True when the overlay exists but does not change the visible body colour. */
  readonly hidden?: boolean
}

/**
 * How the inspected element actually looks, versus how its representation
 * alone would colour it.
 *
 * Precedence: overpaint replaces the theme colour, then the selection marker
 * mixes on top of that; `visibleColor` is the result for one matched element.
 */
export interface InspectAppearance {
  /** Colour from the representation's own colour theme. */
  readonly baseColor?: string
  /** Colour actually visible after overlays. */
  readonly visibleColor?: string
  readonly overlays: readonly InspectOverlay[]
}

/** How one representation currently draws the inspected target. */
export interface InspectStyle {
  /** Mol* component label the representation belongs to. */
  readonly component: string
  /** Representation type, e.g. `cartoon` or `ball-and-stick`. */
  readonly type: string
  /** Colour theme name, e.g. `chain-id` or `uniform`. */
  readonly color: string
  /** Size theme name, e.g. `physical` or `uniform`. */
  readonly size: string
  readonly colorParams?: Readonly<Record<string, string | number | boolean>>
  /** True when Mol* is not drawing this representation (hidden component or representation). */
  readonly hidden?: boolean
  /** Colour the representation's own theme gives the inspected element. */
  readonly baseColor?: string
  /** Colour visible for the inspected element after the overlays below. */
  readonly visibleColor?: string
  /** Overlays that apply to the inspected element in this representation. */
  readonly overlays?: readonly InspectOverlay[]
}

/** Residue/atom totals for one component id inside the inspected target. */
export interface InspectCount {
  readonly compId: string
  readonly kind: InspectKind
  readonly residues: number
  readonly atoms: number
}

/** Totals for one selection entry. */
export interface InspectSelectionGroup {
  readonly atoms: number
  readonly residues: number
  /** Entry label Mol* keeps for the selection, when it has one. */
  readonly label?: string
}

/** Totals for one live selection, plus one row per entry. */
export interface InspectSelection {
  readonly entries: number
  /** Union totals: entries may overlap. */
  readonly atoms: number
  readonly residues: number
  readonly groups?: readonly InspectSelectionGroup[]
}

/** Result of one {@link InspectRequest}. */
export interface InspectResult {
  /** What was inspected, e.g. `whole structure` or `residue E71`. */
  readonly target: string
  readonly detail: InspectDetail
  readonly atoms: number
  readonly residues: number
  readonly chains: number
  readonly models: number
  /** Per component id totals, always complete regardless of the row budget. */
  readonly counts: readonly InspectCount[]
  /** Residue rows; present for `residues` and `atoms` detail. */
  readonly residueRows?: readonly InspectResidue[]
  /** Representations drawing the target, with their colour and style. */
  readonly styles: readonly InspectStyle[]
  /**
   * Effective look of the target: the last drawn style plus its overlays.
   *
   * Absent when the target matches nothing, so an empty selection carries no
   * appearance section.
   */
  readonly appearance?: InspectAppearance
  /** Live selection totals, when anything is selected. */
  readonly selection?: InspectSelection
  /** Live focus totals, when the viewer has a focused location. */
  readonly focus?: InspectSelection
  /** True when the row budget dropped rows; counts and totals stay complete. */
  readonly truncated: boolean
}

/**
 * Draw one style, replacing or overlaying what is already shown.
 *
 * `target` only narrows which part of the structure the new representation
 * covers; it never implies replace or add. `replace` defaults to `true`.
 */
export interface RepresentCommand {
  readonly op: 'represent'
  readonly style: StyleSpec
  readonly target?: StructureSelector
  /**
   * `true` (default): replace the existing representations over the command's
   * scope, then draw the new one. Without `target` that is the whole scoped
   * structure; with `target` only representations covering it are replaced.
   * `false`: keep them and add the new one.
   */
  readonly replace?: boolean
}

/**
 * One replayable viewer command.
 *
 * Loading is a method, not a command: bytes are adapter-owned input and may not
 * be serializable (Codex). Commands only describe changes to an already-loaded
 * structure, so an adapter can store them in a session log and replay them.
 */
export type MolCommand =
  | RepresentCommand
  | {
    readonly op: 'select'
    readonly target: StructureSelector
    readonly mode?: 'select' | 'highlight'
    readonly focus?: boolean
  }
  | { readonly op: 'clear-selection'; readonly mode?: 'select' | 'highlight' }
  | { readonly op: 'focus'; readonly target?: StructureSelector }
  | { readonly op: 'camera'; readonly action: 'reset' }
  | { readonly op: 'background'; readonly color: string | number | 'theme' }
  | {
    readonly op: 'measure'
    readonly kind: 'distance' | 'angle' | 'dihedral'
    readonly targets: readonly StructureSelector[]
  }
  | { readonly op: 'label'; readonly target: StructureSelector; readonly text?: string }
  | { readonly op: 'remove-structure'; readonly structureId: string }
  | { readonly op: 'visibility'; readonly structureId: string; readonly visible: boolean }
  | {
    readonly op: 'align'
    readonly reference: string
    readonly target: string
    readonly method?: AlignmentMethod
    /** Restrict the reference alignment to one chain (auth_asym_id). */
    readonly referenceChain?: string
    /** Restrict the target alignment to one chain (auth_asym_id). */
    readonly targetChain?: string
  }

export type Mol4AgentErrorCode =
  | 'INVALID_COMMAND'
  | 'UNSUPPORTED_FORMAT'
  | 'UNSUPPORTED_REPRESENTATION'
  | 'REPRESENT_FAILED'
  | 'NO_STRUCTURE'
  | 'LOAD_FAILED'
  | 'CAPTURE_FAILED'
  | 'UNSUPPORTED_SOURCE'
  | 'INVALID_ENTRY_ID'
  | 'SUMMARY_UNSUPPORTED'
  | 'DISPOSED'
  | 'UNKNOWN_STRUCTURE'
  | 'DUPLICATE_STRUCTURE_ID'
  | 'ALIGN_FAILED'
  | 'TM_SCORE_FAILED'

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

/** One structure currently displayed in a viewer scene. */
export interface LoadedStructure {
  readonly id: string
  readonly label?: string
  readonly format: MolFormat
  readonly summary: StructureSummary
}

/** Metrics returned by the `align` command. */
export interface AlignmentResult {
  readonly method: AlignmentMethod
  readonly reference: string
  readonly target: string
  /** Root-mean-square deviation of the aligned atoms, in angstroms. */
  readonly rmsd: number
  /** Number of aligned residues/atoms used by the algorithm. */
  readonly alignedLength: number
  /** TM-align only: TM-score normalized by the reference length. */
  readonly tmScoreA?: number
  /** TM-align only: TM-score normalized by the target length. */
  readonly tmScoreB?: number
}

/** Two selections to compare without moving either one. */
export interface TmScoreRequest {
  readonly reference: StructureSelector
  readonly target: StructureSelector
}

/** TM-align metrics for two selections. Nothing is transformed. */
export interface TmScoreResult {
  readonly method: 'tm-align'
  /** Human-readable selector descriptions. */
  readonly reference: string
  readonly target: string
  /** RMSD after optimal superposition of the aligned trace atoms, in angstroms. */
  readonly rmsd: number
  readonly tmScoreA: number
  readonly tmScoreB: number
  readonly alignedLength: number
  readonly referenceAtoms: number
  readonly targetAtoms: number
}

export interface CaptureOptions {
  readonly width?: number
  readonly height?: number
  readonly transparent?: boolean
  readonly background?: string | number
}

/** Narrow a parsed JSON value to a command op without validating every field. */
export function isMolCommandOp(value: unknown): value is MolCommand['op'] {
  return typeof value === 'string' && COMMAND_OPS.has(value as MolCommand['op'])
}

/**
 * Colour parsing is part of the agent-facing protocol: adapters use the same
 * accepted syntax to validate tool arguments and echo the resolved value.
 */
export { COLOR_SYNTAX, formatColor, mixColor, parseColor } from './color.ts'

const COMMAND_OPS = new Set<MolCommand['op']>([
  'represent',
  'select',
  'clear-selection',
  'focus',
  'camera',
  'background',
  'measure',
  'label',
  'remove-structure',
  'visibility',
  'align',
])

export function isMolFormat(value: unknown): value is MolFormat {
  return typeof value === 'string' && (MOL_FORMATS as readonly string[]).includes(value)
}

export function isPresetName(value: unknown): value is PresetName {
  return typeof value === 'string' && (PRESETS as readonly string[]).includes(value)
}

export function isAlignmentMethod(value: unknown): value is AlignmentMethod {
  return typeof value === 'string' && (ALIGNMENT_METHODS as readonly string[]).includes(value)
}

export function isInspectDetail(value: unknown): value is InspectDetail {
  return typeof value === 'string' && (INSPECT_DETAILS as readonly string[]).includes(value)
}

export function isStructureData(value: unknown): value is StructureData {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { data?: unknown; format?: unknown }
  if (!isMolFormat(candidate.format)) return false
  return typeof candidate.data === 'string' || candidate.data instanceof Uint8Array
}
