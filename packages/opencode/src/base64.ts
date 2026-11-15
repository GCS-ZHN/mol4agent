/**
 * Cross-environment base64 helpers. The server bundle runs in Node (has
 * `btoa`/`atob` since Node 16) and the GUI bundle runs in the Electron renderer
 * (browser globals); both provide `btoa`/`atob`, so a single implementation
 * works everywhere without importing `Buffer`.
 *
 * @module @gcszhn/mol4agent-opencode/base64
 */

/** Encode bytes as base64 without exceeding the argument-count limit on spread. */
export function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 0x8000
  let binary = ''
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + chunk, bytes.length)))
  }
  return btoa(binary)
}

/** Decode base64 to bytes. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}
