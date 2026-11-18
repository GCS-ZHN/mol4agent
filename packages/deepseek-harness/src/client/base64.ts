/**
 * Base64 for transport tokens that must survive a single whitespace-delimited
 * command argument (screenshot bytes, compressed inspection answers).
 *
 * @module @gcszhn/mol4agent-deepseekharness/client/base64
 */

/** Encode bytes as standard base64, chunked so large payloads do not overflow the stack. */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}
