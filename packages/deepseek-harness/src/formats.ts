/**
 * DSH-only file recognition.
 *
 * This is exactly the logic core must not own: which suffixes exist, which of
 * them are binary, and how a workspace path maps to a content format. DSH's
 * preview interface gives us a path, so the mapping lives here.
 *
 * @module @gcszhn/mol4agent-deepseekharness/formats
 */
import type { MolFormat } from '@gcszhn/mol4agent-core/protocol'

/** Gzip suffix; the base suffix still selects the molecular format. */
export const GZIP_SUFFIX = 'gz'

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

const BASE_EXTENSIONS = Object.keys(EXTENSION_FORMATS)

/** Gzip variants claimed by the previewer, e.g. `pdb.gz`. */
export const GZIP_EXTENSIONS: readonly string[] = BASE_EXTENSIONS.map(extension => `${extension}.${GZIP_SUFFIX}`)

/** Every suffix the document preview claims, in display order. */
export const PREVIEW_EXTENSIONS: readonly string[] = [...BASE_EXTENSIONS, ...GZIP_EXTENSIONS]

/** Suffixes whose bytes are not text; used for DSH's binary classification. */
export const BINARY_EXTENSIONS: readonly string[] = ['bcif', ...GZIP_EXTENSIONS]

/**
 * Map a file name or path to a content format.
 *
 * DSH-specific by design: core receives the resulting `MolFormat`, never the
 * path. Returns undefined for files this adapter does not claim.
 */
export function formatOfFile(fileNameOrPath: string): MolFormat | undefined {
  const normalized = fileNameOrPath.replaceAll('\\', '/')
  const name = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase()
  if (!name.endsWith(`.${GZIP_SUFFIX}`)) {
    const dot = name.lastIndexOf('.')
    return dot < 0 ? undefined : EXTENSION_FORMATS[name.slice(dot + 1)]
  }
  const base = name.slice(0, -(`.${GZIP_SUFFIX}`.length))
  const dot = base.lastIndexOf('.')
  if (dot < 0) return undefined
  return EXTENSION_FORMATS[base.slice(dot + 1)]
}

/** Whether a path is explicitly gzip-encoded. */
export function isGzipFile(fileNameOrPath: string): boolean {
  return /\.gz$/iu.test(fileNameOrPath.replaceAll('\\', '/'))
}

/** Display name for a workspace path, without decoding a URL. */
export function baseNameOf(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1) || path
}
