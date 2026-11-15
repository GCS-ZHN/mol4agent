/**
 * Host-side gzip decoding. Compression is an adapter transport concern; core
 * receives the decoded bytes plus the explicit molecular format.
 *
 * @module @gcszhn/mol4agent-chatgpt/host/gzip
 */
import { gunzipSync } from 'node:zlib'

/** Decode one gzip payload, enforcing the decompressed-size limit. */
export function gunzipBytes(data: Uint8Array, maxBytes: number): Uint8Array {
  try {
    const decoded = gunzipSync(data, { maxOutputLength: maxBytes })
    if (decoded.byteLength > maxBytes) {
      throw new Error(`decompressed file exceeds ${maxBytes} bytes`)
    }
    return new Uint8Array(decoded)
  } catch (reason) {
    const detail = reason instanceof Error ? reason.message : String(reason)
    throw new Error(`gzip decompression failed: ${detail}`)
  }
}
