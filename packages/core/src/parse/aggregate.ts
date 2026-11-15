/**
 * Format-agnostic aggregation of per-atom facts into a `StructureSummary`.
 *
 * Parsers feed rows here; nothing in this module knows about file names or
 * specific formats.
 *
 * @module @gcszhn/mol4agent-core/parse/aggregate
 */
import type { ChainSummary, MolFormat, StructureSummary } from '../protocol.ts'

export interface AtomRow {
  readonly record: 'atom' | 'hetatm'
  readonly compId: string
  readonly chainId: string
  readonly seqId: string
}

const WATER_COMP_IDS = new Set(['HOH', 'WAT', 'H2O', 'DOD', 'TIP', 'TIP3', 'SOL'])
const ION_COMP_IDS = new Set([
  'NA', 'CL', 'K', 'MG', 'CA', 'ZN', 'FE', 'FE2', 'MN', 'CU', 'CU1', 'CO', 'NI', 'CD', 'HG', 'SR', 'CS', 'BA',
])

interface ChainBucket {
  atoms: number
  readonly residues: Set<string>
  readonly compIds: Set<string>
  polymer: boolean
}

/** Incremental accumulator so large files do not need a per-atom object array. */
export class SummaryBuilder {
  private atomCount = 0
  private modelCount = 1
  private title: string | undefined
  private readonly chains = new Map<string, ChainBucket>()
  private readonly ligandResidues = new Map<string, Set<string>>()

  atom(row: AtomRow, model = 1): void {
    this.atomCount += 1
    if (model > this.modelCount) this.modelCount = model
    const chainId = row.chainId === '' ? '_' : row.chainId
    let chain = this.chains.get(chainId)
    if (chain === undefined) {
      chain = { atoms: 0, residues: new Set(), compIds: new Set(), polymer: false }
      this.chains.set(chainId, chain)
    }
    chain.atoms += 1
    chain.compIds.add(row.compId)
    const residueKey = `${row.seqId}|${row.compId}`
    chain.residues.add(residueKey)
    if (row.record === 'atom') {
      chain.polymer = true
    } else if (!WATER_COMP_IDS.has(row.compId) && !ION_COMP_IDS.has(row.compId)) {
      let set = this.ligandResidues.get(row.compId)
      if (set === undefined) {
        set = new Set()
        this.ligandResidues.set(row.compId, set)
      }
      set.add(`${chainId}|${residueKey}`)
    }
  }

  setTitle(title: string | undefined): void {
    if (title !== undefined && title !== '') this.title = title
  }

  setModelCount(count: number): void {
    if (count > 0) this.modelCount = count
  }

  finish(format: MolFormat, label?: string): StructureSummary {
    const chains: ChainSummary[] = []
    let residues = 0
    for (const [id, bucket] of this.chains) {
      residues += bucket.residues.size
      chains.push({
        id,
        kind: chainKind(bucket),
        atoms: bucket.atoms,
        residues: bucket.residues.size,
        compIds: [...bucket.compIds].sort().slice(0, 12),
      })
    }
    chains.sort((a, b) => a.id.localeCompare(b.id))
    const ligands = [...this.ligandResidues.entries()]
      .map(([compId, set]) => ({ compId, count: set.size }))
      .sort((a, b) => b.count - a.count || a.compId.localeCompare(b.compId))
    return {
      format,
      label,
      title: this.title,
      atomCount: this.atomCount,
      residueCount: residues,
      modelCount: this.modelCount,
      chains,
      ligands,
      complete: true,
    }
  }
}

function chainKind(bucket: ChainBucket): ChainSummary['kind'] {
  if (bucket.polymer) return 'polymer'
  const comps = [...bucket.compIds]
  if (comps.length > 0 && comps.every(id => WATER_COMP_IDS.has(id))) return 'water'
  if (comps.length > 0 && comps.every(id => ION_COMP_IDS.has(id))) return 'ion'
  if (comps.length > 0) return 'ligand'
  return 'other'
}

export function isWaterCompId(compId: string): boolean {
  return WATER_COMP_IDS.has(compId)
}

export function isIonCompId(compId: string): boolean {
  return ION_COMP_IDS.has(compId)
}
