/**
 * Browser half of the inspection and TM-score rendezvous.
 *
 * The inspection answer is plain data whose size grows with the requested
 * detail, so it is gzipped through the platform `CompressionStream` before it
 * becomes an app-tool argument. TM-score metrics are tiny and use plain JSON.
 *
 * @module @gcszhn/mol4agent-chatgpt/client/inspect
 */
import type { InspectAnswer, TmScoreAnswer } from '../inspect.ts'

/** Pack one inspection answer into the base64 token the server expects. */
export async function encodeInspectAnswer(answer: InspectAnswer): Promise<string> {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('this browser cannot compress the inspection answer')
  }
  const bytes = new TextEncoder().encode(JSON.stringify(answer))
  const stream = new Blob([bytes as unknown as BlobPart]).stream()
    .pipeThrough(new CompressionStream('gzip'))
  const packed = new Uint8Array(await new Response(stream).arrayBuffer())
  return bytesToBase64(packed)
}

/** Pack one TM-score answer as plain JSON. */
export function encodeTmScoreAnswer(answer: TmScoreAnswer): string {
  return JSON.stringify(answer)
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 0x8000
  let binary = ''
  for (let index = 0; index < bytes.length; index += chunk) {
    const slice = bytes.subarray(index, Math.min(index + chunk, bytes.length))
    binary += String.fromCharCode(...slice)
  }
  return btoa(binary)
}
