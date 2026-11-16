/**
 * Pure interpretation of host links for the GUI's `LinkHandler` and launcher.
 *
 * The GUI must not classify a path as local or remote by applying its own OS
 * rules: the desktop window can show sessions from remote servers. This module
 * only decodes the URI spelling and detects obvious non-file schemes; the
 * server that owns the session resolves the path.
 *
 * @module @gcszhn/mol4agent-opencode/gui/links
 */

/** Structure files the LinkHandler claims (`.gz` variants included). */
export const MOLECULAR_HREF = /\.(pdb|ent|pdbqt|pqr|cif|mmcif|mcif|bcif|mol|sdf|sd|mol2|xyz|gro)(\.gz)?$/iu

const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/u
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u

/**
 * Decode a `file://` link to the path the host wrote. A leading `/C:/` from
 * `file:///C:/...` is left alone: the server normalizes it on Windows and
 * rejects it on POSIX as a client-local path.
 */
export function hrefToPath(href: string): string {
  if (!href.startsWith('file://')) return href
  const raw = href.slice('file://'.length)
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** A non-file URL (`https:`, `mailto:`, ...), never a Windows drive path. */
export function isRemoteLink(href: string): boolean {
  if (href.startsWith('file://')) return false
  if (WINDOWS_DRIVE.test(href)) return false
  return SCHEME.test(href)
}

/** Text that names a path rather than a bare file name in prose. */
export function isPathLike(href: string): boolean {
  return /[\\/]/u.test(href)
}

/** The file name of a path or file URL, for tab titles and cache keys. */
export function basenameOf(href: string): string {
  const path = hrefToPath(href).replaceAll('\\', '/')
  return path.slice(path.lastIndexOf('/') + 1)
}
