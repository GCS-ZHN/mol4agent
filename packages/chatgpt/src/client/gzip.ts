/**
 * Browser-side gzip decoding for host-resource fallbacks. The server normally
 * decodes bytes before publishing them, but a host-provided `fileResourceUri`
 * may still contain the original gzip payload.
 *
 * @module @gcszhn/mol4agent-chatgpt/client/gzip
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
