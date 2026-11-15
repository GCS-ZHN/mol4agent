/**
 * Browser-side gzip decoding. Uses the platform DecompressionStream so the
 * client does not need a compression dependency.
 *
 * @module @gcszhn/mol4agent-deepseekharness/client/gzip
 */
export async function gunzipBytes(data: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('gzip preview is not supported by this browser')
  }
  try {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))
    const decoded = await new Response(stream).arrayBuffer()
    if (decoded.byteLength > maxBytes) {
      throw new Error(`decompressed file exceeds ${maxBytes} bytes`)
    }
    return new Uint8Array(decoded)
  } catch (reason) {
    const detail = reason instanceof Error ? reason.message : String(reason)
    throw new Error(`gzip decompression failed: ${detail}`)
  }
}
