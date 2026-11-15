/** Minimal mmCIF summary parser: reads the `_atom_site` loop only. @module @gcszhn/mol4agent-core/parse/cif */
import type { MolFormat, StructureSummary } from '../protocol.ts'
import { SummaryBuilder } from './aggregate.ts'

/**
 * Summarize an mmCIF file by reading its `_atom_site` loop.
 *
 * This intentionally does not build a full CIF data model: it understands loop
 * tags, quoted values, and the handful of columns a summary needs. Anything
 * fancier (multi-line semicolon rows in `_atom_site`) is skipped rather than
 * guessed.
 */
export function summarizeCif(text: string, format: MolFormat, label?: string): StructureSummary {
  const builder = new SummaryBuilder()
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim()
    if (line.startsWith('_struct.title')) {
      const rest = line.slice('_struct.title'.length).trim()
      const title = rest.startsWith(';') ? rest.slice(1).trim() : unquote(rest)
      builder.setTitle(title)
      continue
    }
    if (line !== 'loop_') continue
    let cursor = i + 1
    const tags: string[] = []
    while (cursor < lines.length && lines[cursor]!.trim().startsWith('_')) {
      tags.push(lines[cursor]!.trim())
      cursor += 1
    }
    if (tags.length === 0 || !tags.every(tag => tag.startsWith('_atom_site.'))) continue
    const columns = new Map<string, number>()
    for (const [index, tag] of tags.entries()) columns.set(tag.slice('_atom_site.'.length), index)
    const groupPdb = columns.get('group_PDB')
    const compId = columns.get('label_comp_id') ?? columns.get('auth_comp_id')
    const chain = columns.get('auth_asym_id') ?? columns.get('label_asym_id')
    const seqId = columns.get('auth_seq_id') ?? columns.get('label_seq_id')
    const insCode = columns.get('pdbx_PDB_ins_code')
    const modelColumn = columns.get('pdbx_PDB_model_num')
    if (compId === undefined || chain === undefined || seqId === undefined) continue
    const models = new Set<number>()
    for (; cursor < lines.length; cursor += 1) {
      const row = lines[cursor]!.trim()
      if (row === '' || row === '#') continue
      if (row.startsWith('_') || row === 'loop_' || row.startsWith('data_') || row.startsWith('save_')) break
      const values = tokenize(row)
      if (values.length < tags.length) continue
      const record = groupPdb === undefined ? 'atom' : values[groupPdb] === 'HETATM' ? 'hetatm' : 'atom'
      const insertion = insCode === undefined ? '' : clean(values[insCode])
      const seq = clean(values[seqId]!)
      const parsedModel = modelColumn === undefined ? 1 : Number.parseInt(clean(values[modelColumn]) ?? '', 10)
      const model = Number.isFinite(parsedModel) && parsedModel > 0 ? parsedModel : 1
      models.add(model)
      builder.atom({
        record,
        compId: clean(values[compId]!) || 'UNK',
        chainId: clean(values[chain]!) || '_',
        seqId: insertion === '' ? seq : `${seq}${insertion}`,
      }, model)
    }
    if (models.size > 0) builder.setModelCount(models.size)
    i = cursor - 1
  }
  return builder.finish(format, label)
}

function clean(value: string | undefined): string {
  if (value === undefined || value === '?' || value === '.') return ''
  return value
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === "'" || first === '"') && last === first) return value.slice(1, -1)
  }
  return value
}

function tokenize(line: string): string[] {
  const values: string[] = []
  let index = 0
  while (index < line.length) {
    while (index < line.length && /\s/u.test(line[index]!)) index += 1
    if (index >= line.length) break
    const char = line[index]!
    if (char === "'" || char === '"') {
      index += 1
      let value = ''
      while (index < line.length) {
        if (line[index] === char && (index + 1 >= line.length || /\s/u.test(line[index + 1]!))) {
          index += 1
          break
        }
        value += line[index]
        index += 1
      }
      values.push(value)
    } else {
      let value = ''
      while (index < line.length && !/\s/u.test(line[index]!)) {
        value += line[index]
        index += 1
      }
      values.push(value)
    }
  }
  return values
}
