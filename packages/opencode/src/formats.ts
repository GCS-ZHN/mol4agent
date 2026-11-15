/**
 * OpenCode-only file recognition: the logic core must not own. Which suffixes
 * exist, which are binary, and how a path maps to a content format all live
 * here; core receives only `{ data, format, label }`.
 *
 * @module @gcszhn/mol4agent-opencode/formats
 */
import type { MolFormat } from '@gcszhn/mol4agent-core/protocol'

/** Suffix → content format. Keys are lowercase, without the dot. */
export const EXTENSION_FORMATS: Readonly<Record<string, MolFormat>> = {
  pdb: 'pdb',
  ent: 'pdb',
  pdbqt: 'pdbqt',
  pqr: 'pqr',
  cif: 'mmcif',
  mmcif: 'mmcif',
  mcif: 'mmcif',
  bcif: 'bcif',
  mol: 'mol',
  sdf: 'sdf',
  sd: 'sdf',
  mol2: 'mol2',
  xyz: 'xyz',
  gro: 'gro',
}

/** Suffixes whose bytes are not text. */
export const BINARY_EXTENSIONS: readonly string[] = ['bcif']

/** Map a file name or path to a content format. */
export function formatOfFile(fileNameOrPath: string): MolFormat | undefined {
  const normalized = fileNameOrPath.replaceAll('\\', '/')
  const name = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase()
  const dot = name.lastIndexOf('.')
  if (dot < 0) return undefined
  return EXTENSION_FORMATS[name.slice(dot + 1)]
}

/** Display name for a path, without decoding a URL. */
export function baseNameOf(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1) || path
}

/** Whether bytes for this format must be passed to core as binary. */
export function isBinaryFormat(format: MolFormat): boolean {
  return BINARY_EXTENSIONS.includes(format)
}
