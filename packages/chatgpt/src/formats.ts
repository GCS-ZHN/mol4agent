/**
 * ChatGPT/Codex-only file recognition.
 *
 * This is exactly the logic core must not own: which suffixes exist, which of
 * them are binary, and how a path maps to a content format. The MCP server
 * receives a path from the model, reads the bytes itself, and passes only
 * `{ data, format, label }` to core.
 *
 * @module @gcszhn/mol4agent-chatgpt/formats
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

/** Gzip variants claimed by the file viewer, e.g. `pdb.gz`. */
export const GZIP_EXTENSIONS: readonly string[] = BASE_EXTENSIONS.map(extension => `${extension}.${GZIP_SUFFIX}`)

/** Every suffix the file viewer claims, in display order. */
export const PREVIEW_EXTENSIONS: readonly string[] = [...BASE_EXTENSIONS, ...GZIP_EXTENSIONS]

/** Suffixes whose bytes are not text. */
export const BINARY_EXTENSIONS: readonly string[] = ['bcif']

/** Map a file name or path to a content format. */
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

/** Dot-prefixed suffixes for the MCP extension file-viewer entrypoint. */
export function previewFileExtensions(): readonly string[] {
  return PREVIEW_EXTENSIONS.map(extension => `.${extension}`)
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
