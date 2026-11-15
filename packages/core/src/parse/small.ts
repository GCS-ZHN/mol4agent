/** Small-format summary parsers: XYZ, GRO, MOL2. @module @gcszhn/mol4agent-core/parse/small */
import type { MolFormat, StructureSummary } from '../protocol.ts'
import { SummaryBuilder } from './aggregate.ts'

/** XYZ: atom count on line 1, comment on line 2. */
export function summarizeXyz(text: string, format: MolFormat, label?: string): StructureSummary {
  const lines = text.split(/\r?\n/)
  const declared = Number.parseInt((lines[0] ?? '').trim(), 10)
  const title = (lines[1] ?? '').trim()
  const builder = new SummaryBuilder()
  builder.setTitle(title)
  const count = Number.isFinite(declared) && declared > 0 ? declared : Math.max(0, lines.length - 2)
  for (let index = 0; index < count; index += 1) {
    builder.atom({ record: 'atom', compId: 'XYZ', chainId: '_', seqId: '1' })
  }
  return builder.finish(format, label)
}

/** GRO: fixed columns; one pseudo-chain, residues keyed by residue number. */
export function summarizeGro(text: string, format: MolFormat, label?: string): StructureSummary {
  const lines = text.split(/\r?\n/).filter(line => line.trim() !== '')
  const title = (lines[0] ?? '').trim()
  const builder = new SummaryBuilder()
  builder.setTitle(title)
  const body = lines.slice(1, Math.max(1, lines.length - 1))
  for (const line of body) {
    const seqId = line.slice(0, 5).trim() || '?'
    const compId = line.slice(5, 10).trim() || 'UNK'
    builder.atom({ record: 'atom', compId, chainId: '_', seqId })
  }
  return builder.finish(format, label)
}

/** MOL2: parse the molecule title and the ATOM section (subst_id/subst_name). */
export function summarizeMol2(text: string, format: MolFormat, label?: string): StructureSummary {
  const lines = text.split(/\r?\n/)
  const builder = new SummaryBuilder()
  let section = ''
  let titleSet = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('@<TRIPOS>')) {
      section = trimmed.slice('@<TRIPOS>'.length).toUpperCase()
      continue
    }
    if (section === 'MOLECULE' && !titleSet && trimmed !== '') {
      builder.setTitle(trimmed)
      titleSet = true
      continue
    }
    if (section !== 'ATOM' || trimmed === '') continue
    const fields = trimmed.split(/\s+/u)
    if (fields.length < 6) continue
    // MOL2 ATOM columns: id name x y z type subst_id subst_name charge.
    const compId = fields[7] ?? fields[5] ?? 'UNK'
    const seqId = fields[6] ?? '1'
    builder.atom({ record: 'hetatm', compId, chainId: '_', seqId })
  }
  return builder.finish(format, label)
}
