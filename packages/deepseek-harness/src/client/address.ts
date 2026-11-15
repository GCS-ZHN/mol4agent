/**
 * DSH resource addresses, copied from the workspace-path grammar so this
 * adapter does not depend on a Harness Client package at runtime.
 *
 * @module @gcszhn/mol4agent-deepseekharness/client/address
 */
const FILE_ADDRESS_PREFIX = 'dsh-resource://file/'

/** Build the session-scoped file address for an absolute path. */
export function sessionFileAddress(sessionId: string, path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '')
  return `${FILE_ADDRESS_PREFIX}session/${encodeSegment(sessionId)}/${normalized.split('/').map(encodeSegment).join('/')}`
}

/** Read the file path out of a session-scoped address, or undefined for another resource. */
export function sessionPathOf(address: string): string | undefined {
  const prefix = `${FILE_ADDRESS_PREFIX}session/`
  if (!address.startsWith(prefix)) return undefined
  const end = address.search(/[?#]/)
  const parts = address.slice(prefix.length, end === -1 ? undefined : end).split('/')
  const id = parts.shift()
  if (id === undefined || id === '') return undefined
  try {
    return parts.map(decodeURIComponent).join('/')
  } catch {
    return undefined
  }
}

function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/gi, ':')
}
