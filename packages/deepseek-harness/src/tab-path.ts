/**
 * One spelling for tab-page ids across the Host/client boundary.
 *
 * DSH resource addresses and the Sidebar tab registry are `/`-separated on
 * every platform, and the document body recovers its tab's path from a
 * `dsh-resource://file/session/...` address with `/` separators. The Host
 * projection therefore cannot key `tabs` with a Windows-native path
 * (`D:\work\5jds.pdb`): the body would look up `D:/work/5jds.pdb`, miss, and
 * silently skip every viewer command and screenshot.
 *
 * This module is shared by both halves (no Node or DOM imports), so the
 * projection, the tool echoes, and the client all canonicalize through it.
 *
 * @module @gcszhn/mol4agent-deepseekharness/tab-path
 */

/**
 * The canonical tab-page id for a session path.
 *
 * Backslashes become `/`, matching the address grammar; a Windows drive letter
 * is uppercased so `c:\a` and `C:/a` are one tab. Other path segments keep
 * their case because a POSIX Host is case-sensitive.
 */
export function canonicalTabPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^([a-z]):\//u, (_match, drive: string) => `${drive.toUpperCase()}:/`)
}
