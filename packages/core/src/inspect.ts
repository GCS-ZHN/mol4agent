/**
 * Inspection totals, rows, and counts for an already-extracted structure.
 *
 * Mol* extraction lives in `inspect-mol.ts` and the viewer wiring in
 * `inspect-plugin.ts`. This module owns the aggregation so it stays free of
 * Mol* and DOM imports and can be tested under plain Node.
 *
 * @module @gcszhn/mol4agent-core/inspect
 */
import {
  DEFAULT_INSPECT_LIMIT,
  type InspectAtom,
  type InspectCount,
  type InspectDetail,
  type InspectKind,
  type InspectResidue,
  type InspectResult,
  type InspectSelection,
  type InspectStyle,
  type InspectVector,
} from './protocol.ts'

/** One residue with every atom Mol* placed for it, before detail filtering. */
export interface ResidueRecord {
  readonly chain: string
  readonly seqId: number
  readonly labelSeqId: number
  readonly compId: string
  readonly kind: InspectKind
  readonly center: InspectVector
  readonly atoms: readonly InspectAtom[]
}

/** Everything {@link buildInspectResult} needs; produced by the Mol* extractor. */
export interface InspectInput {
  /** Human label of the queried target, e.g. `whole structure`. */
  readonly target: string
  readonly detail: InspectDetail
  /** Distinct chain ids inside the target. */
  readonly chains: readonly string[]
  readonly models: number
  readonly records: readonly ResidueRecord[]
  readonly styles: readonly InspectStyle[]
  readonly selection?: InspectSelection
  readonly focus?: InspectSelection
  readonly limit?: number
}

/** Row budget bounds: an agent asking for 0 or 10^9 must not break the result. */
const MIN_LIMIT = 1
const MAX_LIMIT = 5_000

/** Ordering used for count rows: solvent first, polymer last. */
const KIND_ORDER: Readonly<Record<InspectKind, number>> = {
  water: 0,
  ion: 1,
  ligand: 2,
  polymer: 3,
  other: 4,
}

/** Whether a detail level lists residues at all. */
export function listsResidues(detail: InspectDetail): boolean {
  return detail === 'residues' || detail === 'atoms'
}

/**
 * Classify a residue from Mol*'s entity type plus entity subtype.
 *
 * Mol* reports ions and ligands both as entity type `non-polymer`, so the
 * subtype is what separates them; this mirrors the "Ion" selection query in the
 * official UI, which tests `entitySubtype === 'ion'`.
 */
export function kindOfEntity(entityType: string | undefined, entitySubtype: string | undefined): InspectKind {
  if (entityType === 'water') return 'water'
  if (entitySubtype === 'ion') return 'ion'
  if (entityType === 'polymer' || entityType === 'branched' || entityType === 'macrolide') return 'polymer'
  if (entityType === 'non-polymer') return 'ligand'
  return 'other'
}

/** Mean of the given positions; the first one when the list is empty. */
export function centroid(points: readonly InspectVector[]): InspectVector {
  const first = points[0]
  if (first === undefined) return { x: 0, y: 0, z: 0 }
  let x = 0
  let y = 0
  let z = 0
  for (const point of points) {
    x += point.x
    y += point.y
    z += point.z
  }
  const count = points.length
  return { x: x / count, y: y / count, z: z / count }
}

/** Residue/atom totals per component id, complete regardless of the row budget. */
export function countCompIds(records: readonly ResidueRecord[]): InspectCount[] {
  const merged = new Map<string, { kind: InspectKind; residues: number; atoms: number }>()
  for (const record of records) {
    const existing = merged.get(record.compId)
    if (existing === undefined) {
      merged.set(record.compId, { kind: record.kind, residues: 1, atoms: record.atoms.length })
    } else {
      existing.residues += 1
      existing.atoms += record.atoms.length
    }
  }
  return [...merged.entries()]
    .map(([compId, totals]) => ({ compId, ...totals }))
    .sort((left, right) => {
      const byKind = KIND_ORDER[left.kind] - KIND_ORDER[right.kind]
      if (byKind !== 0) return byKind
      if (left.residues !== right.residues) return right.residues - left.residues
      return left.compId < right.compId ? -1 : left.compId > right.compId ? 1 : 0
    })
}

/** Round a coordinate to the precision an agent can act on (0.001 A). */
function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

function roundVector(vector: InspectVector): InspectVector {
  return { x: round(vector.x), y: round(vector.y), z: round(vector.z) }
}

function residueRow(record: ResidueRecord, withAtoms: boolean): InspectResidue {
  const center = roundVector(record.center)
  return {
    chain: record.chain,
    seqId: record.seqId,
    labelSeqId: record.labelSeqId,
    compId: record.compId,
    kind: record.kind,
    atoms: record.atoms.length,
    ...center,
    ...(withAtoms
      ? {
        atomRows: record.atoms.map(atom => ({
          name: atom.name,
          element: atom.element,
          x: round(atom.x),
          y: round(atom.y),
          z: round(atom.z),
          ...(atom.occupancy === undefined ? {} : { occupancy: round(atom.occupancy) }),
          ...(atom.bFactor === undefined ? {} : { bFactor: round(atom.bFactor) }),
          ...(atom.altId === undefined ? {} : { altId: atom.altId }),
        })),
      }
      : {}),
  }
}

function clampLimit(limit: number | undefined): number {
  const requested = limit === undefined || !Number.isFinite(limit) ? DEFAULT_INSPECT_LIMIT : Math.floor(limit)
  return Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, requested))
}

/** Sort residues into a stable chain/sequence order for the model to read. */
function compareRecords(left: ResidueRecord, right: ResidueRecord): number {
  if (left.chain !== right.chain) return left.chain < right.chain ? -1 : 1
  if (left.seqId !== right.seqId) return left.seqId - right.seqId
  return left.compId < right.compId ? -1 : left.compId > right.compId ? 1 : 0
}

/**
 * Assemble one `InspectResult`.
 *
 * Totals and counts always cover the whole target; only the listed rows obey
 * `limit`, and `truncated` says whether that budget dropped anything, so an
 * agent can tell "200 residues" apart from "at least 200 residues". Counts are
 * part of every detail level because they answer "how many waters / Cys" in the
 * default call.
 */
export function buildInspectResult(input: InspectInput): InspectResult {
  const limit = clampLimit(input.limit)
  const ordered = [...input.records].sort(compareRecords)
  const atomCount = ordered.reduce((total, record) => total + record.atoms.length, 0)
  const withAtoms = input.detail === 'atoms'
  const rows = listsResidues(input.detail) ? ordered.slice(0, limit) : undefined
  return {
    target: input.target,
    detail: input.detail,
    atoms: atomCount,
    residues: ordered.length,
    chains: input.chains.length,
    models: input.models,
    counts: countCompIds(ordered),
    ...(rows === undefined ? {} : { residueRows: rows.map(record => residueRow(record, withAtoms)) }),
    styles: input.styles,
    ...(input.selection === undefined ? {} : { selection: input.selection }),
    ...(input.focus === undefined ? {} : { focus: input.focus }),
    truncated: rows !== undefined && ordered.length > rows.length,
  }
}
