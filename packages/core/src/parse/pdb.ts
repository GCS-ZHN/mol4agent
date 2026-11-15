/** PDB-like text parser (PDB, PDBQT, PQR). @module @gcszhn/mol4agent-core/parse/pdb */
import type { MolFormat, StructureSummary } from '../protocol.ts'
import { SummaryBuilder } from './aggregate.ts'

/**
 * Summarize fixed-column ATOM/HETATM records.
 *
 * PDBQT and PQR keep the PDB chain/residue columns closely enough for a
 * summary; their chemistry columns are ignored.
 */
export function summarizePdbLike(text: string, format: MolFormat, label?: string): StructureSummary {
  const builder = new SummaryBuilder()
  let model = 1
  let sawModel = false
  const models = new Set<number>()
  for (const line of text.split('\n')) {
    const record = line.slice(0, 6).trim()
    if (record === 'MODEL') {
      sawModel = true
      model = parseModelNumber(line, model)
      continue
    }
    if (record === 'TITLE') {
      builder.setTitle(line.slice(10).trim())
      continue
    }
    if (record !== 'ATOM' && record !== 'HETATM') continue
    const altLoc = line.charAt(16)
    if (altLoc !== ' ' && altLoc !== 'A') continue
    const compId = line.slice(17, 20).trim() || 'UNK'
    const chainId = line.slice(21, 22).trim() || '_'
    const seqId = line.slice(22, 26).trim() || '?'
    const insCode = line.charAt(26).trim()
    models.add(model)
    builder.atom(
      { record: record === 'ATOM' ? 'atom' : 'hetatm', compId, chainId, seqId: insCode === '' ? seqId : `${seqId}${insCode}` },
      model,
    )
  }
  if (sawModel) builder.setModelCount(models.size || 1)
  return builder.finish(format, label)
}

function parseModelNumber(line: string, fallback: number): number {
  const parsed = Number.parseInt(line.slice(10, 14).trim(), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
