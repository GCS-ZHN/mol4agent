/**
 * Content-format mapping for Mol*, with no notion of file names.
 *
 * An adapter that decides `.pdb` means `pdb` lives outside this package. Here a
 * `MolFormat` is already known, and this module only says how Mol* should parse
 * bytes of that format.
 *
 * @module @gcszhn/mol4agent-core/formats
 */
import type { BuiltInTrajectoryFormat } from 'molstar/lib/mol-plugin-state/formats/trajectory'
import { Mol4AgentError, type MolFormat } from './protocol.ts'

/** How Mol* loads one content format. */
export interface MolstarFormat {
  /** Mol* parser name. */
  readonly parser: BuiltInTrajectoryFormat
  /** Whether the bytes are normally binary. Adapters may override for a specific input. */
  readonly binary: boolean
  /** Human-readable note for error messages. */
  readonly note?: string
}

const FORMATS: Readonly<Record<MolFormat, MolstarFormat>> = {
  pdb: { parser: 'pdb', binary: false },
  pdbqt: { parser: 'pdbqt', binary: false },
  pqr: { parser: 'pqr', binary: false },
  mmcif: { parser: 'mmcif', binary: false },
  // BCIF is parsed by Mol*'s mmCIF provider from binary data.
  bcif: { parser: 'mmcif', binary: true, note: 'binary CIF' },
  mol: { parser: 'mol', binary: false },
  sdf: { parser: 'sdf', binary: false },
  mol2: { parser: 'mol2', binary: false },
  xyz: { parser: 'xyz', binary: false },
  gro: { parser: 'gro', binary: false },
}

/** Resolve the Mol* parser for an explicit content format. */
export function molstarFormatOf(format: MolFormat): MolstarFormat {
  const descriptor = FORMATS[format]
  if (descriptor === undefined) {
    throw new Mol4AgentError('UNSUPPORTED_FORMAT', `unknown structure format "${format}"`)
  }
  return descriptor
}

/** All formats core can hand to Mol*. */
export function supportedFormats(): readonly MolFormat[] {
  return Object.keys(FORMATS) as MolFormat[]
}
