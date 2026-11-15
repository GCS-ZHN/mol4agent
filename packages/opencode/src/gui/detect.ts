/**
 * Byte-level structure detection for the OpenCode `FileViewer` path.
 *
 * A `FileViewer` receives the file's bytes but no path, so the format must be
 * inferred from content. Core refuses to inspect suffixes; this adapter owns
 * detection, and the result is passed to core as an explicit `MolFormat`.
 *
 * Deliberately conservative: it only accepts clearly molecular headers so a
 * `FileViewer` registered for the `"text"` artifact kind does not claim
 * ordinary source/markdown files.
 *
 * @module @gcszhn/mol4agent-opencode/detect
 */
import type { MolFormat } from '@gcszhn/mol4agent-core/protocol'

const SNIFF_BYTES = 8192

/** Detect a structure format from the first few KiB, or undefined. */
export function formatOfBytes(bytes: Uint8Array): MolFormat | undefined {
  if (bytes.byteLength === 0) return undefined
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, SNIFF_BYTES))
  const lines = head.split(/\r?\n/)

  // mmCIF: the first non-comment, non-empty line is `data_<id>`.
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    if (/^data_\S+/u.test(trimmed)) return 'mmcif'
    break
  }

  // PDB: line-start records from the PDB fixed-column format.
  if (/^(HEADER|TITLE|COMPND|CRYST1|ATOM  |HETATM|MODEL|SEQRES|DBREF|REMARK)/mu.test(head)) {
    return 'pdb'
  }

  // MOL2: the Tripos record marker.
  if (/@<TRIPOS>/u.test(head)) return 'mol2'

  // SDF/MOL: the V2000/V3000 counts marker or the M  END terminator.
  if (/V2000|V3000|M  END/u.test(head)) return 'sdf'

  // XYZ: first non-empty line is a bare atom count, followed by a comment line
  // and a line of four-space-separated numbers.
  const nonEmpty = lines.filter(line => line.trim() !== '')
  if (nonEmpty.length >= 3 && /^\s*\d+\s*$/u.test(nonEmpty[0] ?? '')) {
    if (/^\s*-?\d+(\.\d+)?\s+-?\d+(\.\d+)?\s+-?\d+(\.\d+)?(\s+\S+)?\s*$/u.test(nonEmpty[2] ?? '')) return 'xyz'
  }

  return undefined
}
