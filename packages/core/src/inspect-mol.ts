/**
 * Turn Mol* structure locations into plain residue records.
 *
 * Only Mol*'s model layer is imported here: no plugin, DOM, or viewer state, so
 * the extraction can be exercised against a real fixture outside a browser.
 * Placement uses `Element.Location.position`, which applies the unit
 * conformation, so coordinates are where Mol* actually draws the atom rather
 * than the raw model row.
 *
 * @module @gcszhn/mol4agent-core/inspect-mol
 */
import { Structure, StructureElement, StructureProperties, Unit } from 'molstar/lib/mol-model/structure'
import type { Vec3 } from 'molstar/lib/mol-math/linear-algebra'
import { centroid, kindOfEntity, type ResidueRecord } from './inspect.ts'
import type { InspectAtom, InspectVector } from './protocol.ts'

/** Residues plus totals extracted from one target's locations. */
export interface ExtractedStructure {
  readonly records: readonly ResidueRecord[]
  /** Distinct chain ids, in first-seen order. */
  readonly chains: readonly string[]
  readonly models: number
}

interface PendingResidue {
  readonly chain: string
  readonly seqId: number
  readonly labelSeqId: number
  readonly compId: string
  readonly kind: ResidueRecord['kind']
  readonly points: InspectVector[]
  readonly atoms: InspectAtom[]
}

/** Read a property that some models (e.g. small-molecule formats) cannot answer. */
function optional(read: () => number): number | undefined {
  try {
    const value = read()
    return Number.isFinite(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Collect residues from every location of `lociList`.
 *
 * `lociList` may span several structures (one viewer can hold more than one);
 * residue identity is therefore keyed per structure instance as well as per
 * unit and residue, so two structures never merge into one row.
 */
export function extractResidues(lociList: readonly StructureElement.Loci[]): ExtractedStructure {
  const residues = new Map<string, PendingResidue>()
  const chains = new Set<string>()
  const models = new Set<unknown>()
  const structureIds = new Map<Structure, number>()
  const position: [number, number, number] = [0, 0, 0]
  const location = StructureElement.Location.create()

  const structureId = (structure: Structure): number => {
    const existing = structureIds.get(structure)
    if (existing !== undefined) return existing
    const id = structureIds.size
    structureIds.set(structure, id)
    return id
  }

  for (const loci of lociList) {
    if (StructureElement.Loci.isEmpty(loci)) continue
    const prefix = structureId(loci.structure)
    StructureElement.Loci.forEachLocation(loci, loc => {
      // Coarse (sphere/gaussian) units have no atom hierarchy to report.
      if (!Unit.isAtomic(loc.unit)) return
      const chain = StructureProperties.chain.auth_asym_id(loc)
      const seqId = StructureProperties.residue.auth_seq_id(loc)
      const labelSeqId = StructureProperties.residue.label_seq_id(loc)
      const compId = StructureProperties.residue.label_comp_id(loc)
      const key = `${prefix}:${loc.unit.id}:${StructureProperties.residue.key(loc)}`

      let pending = residues.get(key)
      if (pending === undefined) {
        pending = {
          chain,
          seqId,
          labelSeqId,
          compId,
          kind: kindOfEntity(StructureProperties.entity.type(loc), StructureProperties.entity.subtype(loc)),
          points: [],
          atoms: [],
        }
        residues.set(key, pending)
        chains.add(chain)
        models.add(loc.unit.model)
      }

      StructureElement.Location.position(position as unknown as Vec3, loc)
      const point: InspectVector = { x: position[0], y: position[1], z: position[2] }
      pending.points.push(point)
      const occupancy = optional(() => StructureProperties.atom.occupancy(loc))
      const bFactor = optional(() => StructureProperties.atom.B_iso_or_equiv(loc))
      const altId = StructureProperties.atom.label_alt_id(loc)
      pending.atoms.push({
        name: StructureProperties.atom.label_atom_id(loc),
        element: StructureProperties.atom.type_symbol(loc),
        ...point,
        ...(occupancy === undefined ? {} : { occupancy }),
        ...(bFactor === undefined ? {} : { bFactor }),
        ...(altId === '' || altId === undefined ? {} : { altId }),
      })
    })
  }

  const records: ResidueRecord[] = []
  for (const pending of residues.values()) {
    records.push({
      chain: pending.chain,
      seqId: pending.seqId,
      labelSeqId: pending.labelSeqId,
      compId: pending.compId,
      kind: pending.kind,
      center: centroid(pending.points),
      atoms: pending.atoms,
    })
  }
  return { records, chains: [...chains], models: models.size }
}
