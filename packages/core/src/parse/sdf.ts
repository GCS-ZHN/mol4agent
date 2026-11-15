/** SDF/MOL summary parser. @module @gcszhn/mol4agent-core/parse/sdf */
import type { MolFormat, StructureSummary } from '../protocol.ts'

/**
 * Summarize one or more MDL molfile records.
 *
 * Each record becomes one ligand-like chain. This is a deliberately coarse
 * summary: an SDF of 500 docking poses reads as 500 models, not as 500 chains
 * of a polymer.
 */
export function summarizeSdf(text: string, format: MolFormat, label?: string): StructureSummary {
  const records = splitRecords(text)
  let atomCount = 0
  const chains: StructureSummary['chains'][number][] = []
  const ligandCounts = new Map<string, number>()
  for (const [index, record] of records.entries()) {
    const lines = record.split(/\r?\n/)
    const title = (lines[0] ?? '').trim() || `record ${index + 1}`
    const counts = findCountsLine(lines)
    const atoms = counts?.atoms ?? 0
    atomCount += atoms
    ligandCounts.set(title, (ligandCounts.get(title) ?? 0) + 1)
    chains.push({
      id: String(index + 1),
      kind: 'ligand',
      atoms,
      residues: 1,
      compIds: [title],
    })
  }
  const ligands = [...ligandCounts.entries()]
    .map(([compId, count]) => ({ compId, count }))
    .sort((a, b) => b.count - a.count)
  return {
    format,
    label,
    atomCount,
    residueCount: records.length,
    modelCount: Math.max(1, records.length),
    chains,
    ligands,
    complete: true,
  }
}

function splitRecords(text: string): string[] {
  const records: string[] = []
  let current: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '$$$$') {
      if (current.some(part => part.trim() !== '')) records.push(current.join('\n'))
      current = []
      continue
    }
    current.push(line)
  }
  if (current.some(part => part.trim() !== '')) records.push(current.join('\n'))
  return records
}

function findCountsLine(lines: readonly string[]): { atoms: number } | undefined {
  for (let index = 0; index < Math.min(lines.length, 8); index += 1) {
    const line = lines[index] ?? ''
    if (/^\s*\d{1,3}\s+\d{1,3}/u.test(line)) {
      const atoms = Number.parseInt(line.slice(0, 3).trim(), 10)
      if (Number.isFinite(atoms)) return { atoms }
    }
  }
  return undefined
}
