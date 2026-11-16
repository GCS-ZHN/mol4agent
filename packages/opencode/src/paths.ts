/**
 * File resolution for the OpenCode server part: the only place a path becomes
 * bytes. The format is derived here and passed explicitly to core.
 *
 * Every path is resolved in the **server's** namespace. A desktop window can
 * connect to a remote OpenCode server, but plugin GUI code always runs against
 * the app's built-in server; the GUI therefore forwards raw host paths and this
 * module resolves them on the server that owns the session. Foreign absolute
 * paths (a Windows drive path on POSIX, or a POSIX path on Windows) are rejected
 * with a clear message instead of being silently re-rooted.
 *
 * @module @gcszhn/mol4agent-opencode/paths
 */
import { readFile, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { MolFormat } from '@gcszhn/mol4agent-core/protocol'
import { EXTENSION_FORMATS, baseNameOf, formatOfFile, isGzipFile } from './formats.ts'

/** One structure file this adapter can hand to the viewer. */
export interface ResolvedMoleculeFile {
  readonly absolutePath: string
  readonly format: MolFormat
  readonly label: string
  readonly bytes: Uint8Array
}

const SUPPORTED = Object.keys(EXTENSION_FORMATS).join(', ')
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/u
/** `file:///C:/...` decodes to `/C:/...`; still a Windows drive path. */
const WINDOWS_URL_DRIVE = /^\/[A-Za-z]:[\\/]/u
const WINDOWS_UNC = /^\\\\/u
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u
const POSIX_SERVER = sep === '/'

/**
 * Whether `path` is absolute in the namespace of the server running this code.
 * Unlike `path.isAbsolute` on POSIX, a Windows drive path is not absolute, and
 * a URL is never a filesystem path.
 */
export function isServerAbsolute(path: string): boolean {
  if (URL_SCHEME.test(path)) return false
  if (POSIX_SERVER) return path.startsWith('/')
  // On Windows, `/data/x` is drive-relative (the current drive is implied).
  // Treating it as absolute is what turns a remote POSIX path into `C:\data\x`.
  return /^[A-Za-z]:[\\/]/u.test(path) || WINDOWS_UNC.test(path)
}

/**
 * Reject paths written in another operating system's namespace, then normalize
 * the one URL-specific spelling the host may produce (`file:///C:/x` decodes to
 * `/C:/x`) on Windows.
 */
function normalizeForServer(input: string, role: string): string {
  const path = input.trim()
  if (path === '') throw new Error(`${role} must be a non-empty string`)
  if (URL_SCHEME.test(path)) {
    throw new Error(`${role} is a URL, not a filesystem path: ${path}`)
  }
  if (POSIX_SERVER) {
    if (WINDOWS_DRIVE.test(path) || WINDOWS_URL_DRIVE.test(path) || WINDOWS_UNC.test(path)) {
      throw new Error(
        `${role} is a Windows path, but the OpenCode server runs on POSIX: ${path}. `
        + 'Pass a path in the server\'s namespace (for example /data/project/x.pdb); '
        + 'a path from the desktop file picker names a file on the client machine, not on the session\'s server.',
      )
    }
    if (path.includes('\\')) {
      throw new Error(
        `${role} contains Windows path separators, but the OpenCode server runs on POSIX: ${path}. `
        + 'Pass a POSIX path using forward slashes.',
      )
    }
    return path
  }
  // Windows: a leading `/` without a drive is not a usable server path.
  if (path.startsWith('/') && !/^\/[A-Za-z]:[\\/]/u.test(path)) {
    throw new Error(
      `${role} is a POSIX absolute path, but the OpenCode server runs on Windows: ${path}. `
      + 'Pass a drive path (for example C:\\data\\project\\x.pdb) or a path relative to the session directory.',
    )
  }
  // `file:///C:/x` decodes to `/C:/x`; drop the URL-only leading slash.
  return /^\/[A-Za-z]:[\\/]/u.test(path) ? path.slice(1) : path
}

/**
 * Resolve a requested path in the server's namespace.
 *
 * `cwd` is the workspace directory the server resolved from the session; a
 * relative path is resolved against it. `base` is an optional
 * workspace-relative directory the host attached to a link; it only applies to
 * relative paths.
 */
export function resolveServerPath(cwd: string, requestedPath: string, base?: string): string {
  const requested = normalizeForServer(requestedPath, 'path')
  const prefix = base === undefined || base.trim() === '' ? '' : normalizeForServer(base, 'path base')
  // Canonicalize an absolute path too, so the tab id and the server's error
  // messages use one spelling (`C:/x` -> `C:\x`, `a/../b` -> `b`).
  if (isServerAbsolute(requested)) return resolve(requested)
  return resolve(cwd, prefix, requested)
}

/**
 * Resolve and read one path, enforcing the adapter's size limit.
 */
export async function resolveMoleculeFile(
  cwd: string,
  requestedPath: string,
  maxFileBytes: number,
  signal: AbortSignal,
  base?: string,
): Promise<ResolvedMoleculeFile> {
  const requested = requestedPath.trim()
  if (requested === '') throw new Error('path must be a non-empty string')
  const absolutePath = resolveServerPath(cwd, requested, base)
  const format = formatOfFile(absolutePath)
  if (format === undefined) {
    throw new Error(`unsupported molecular file type: ${requested}\nsupported suffixes: ${SUPPORTED}`)
  }
  let info
  try {
    info = await stat(absolutePath)
  } catch (reason) {
    throw new Error(`cannot read ${absolutePath}: ${reason instanceof Error ? reason.message : String(reason)}`)
  }
  if (!info.isFile()) throw new Error(`not a regular file: ${absolutePath}`)
  if (info.size > maxFileBytes) {
    throw new Error(`file is too large (${info.size} bytes; limit ${maxFileBytes})`)
  }
  let bytes: Uint8Array = new Uint8Array(await readFile(absolutePath, { signal }))
  if (isGzipFile(absolutePath)) {
    try {
      // `maxOutputLength` caps decompression so a gzip bomb cannot allocate
      // gigabytes before the size check.
      bytes = new Uint8Array(gunzipSync(bytes, { maxOutputLength: maxFileBytes }))
    } catch (reason) {
      throw new Error(`could not decompress ${absolutePath} (limit ${maxFileBytes} bytes): ${reason instanceof Error ? reason.message : String(reason)}`)
    }
  }
  return {
    absolutePath,
    format,
    label: baseNameOf(absolutePath),
    bytes,
  }
}
