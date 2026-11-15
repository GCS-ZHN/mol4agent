/**
 * Byte-oriented structure summaries.
 *
 * Adapters call this after they have bytes and know the content format; no
 * path, extension, filesystem, or harness API is involved. The same parsers
 * run in Node (Host tools) and in the browser (post-load summary).
 *
 * @module @gcszhn/mol4agent-core/parse
 */
import { Mol4AgentError, type StructureData, type StructureSummary } from '../protocol.ts'
import { summarizeCif } from './cif.ts'
import { summarizePdbLike } from './pdb.ts'
import { summarizeSdf } from './sdf.ts'
import { summarizeGro, summarizeMol2, summarizeXyz } from './small.ts'

/**
 * Summarize adapter-supplied bytes.
 *
 * @throws Mol4AgentError `SUMMARY_UNSUPPORTED` for a format that can be
 * rendered but not summarized from bytes (currently BCIF).
 */
export function summarizeStructure(input: StructureData): StructureSummary {
  const text = toText(input.data)
  const label = input.label
  switch (input.format) {
    case 'pdb':
    case 'pdbqt':
    case 'pqr':
      return summarizePdbLike(text, input.format, label)
    case 'mmcif':
      return summarizeCif(text, input.format, label)
    case 'bcif':
      throw new Mol4AgentError(
        'SUMMARY_UNSUPPORTED',
        'binary CIF cannot be summarized from raw bytes yet; open it in the viewer instead',
      )
    case 'mol':
    case 'sdf':
      return summarizeSdf(text, input.format, label)
    case 'mol2':
      return summarizeMol2(text, input.format, label)
    case 'xyz':
      return summarizeXyz(text, input.format, label)
    case 'gro':
      return summarizeGro(text, input.format, label)
  }
}

function toText(data: string | Uint8Array): string {
  return typeof data === 'string' ? data : new TextDecoder('utf-8', { fatal: false }).decode(data)
}

export { summarizeCif, summarizePdbLike, summarizeSdf, summarizeGro, summarizeMol2, summarizeXyz }
