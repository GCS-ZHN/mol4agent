/**
 * Browser half of the inspection rendezvous: pack the viewer's answer into one
 * command argument the Host can decode.
 *
 * The answer is plain data whose size grows with the requested detail, so it is
 * gzipped through the platform `CompressionStream` and base64-encoded before it
 * becomes a `mol4agent_inspect` input. The Host reverses both steps.
 *
 * @module @gcszhn/mol4agent-deepseekharness/client/inspect
 */
import type { MolInspectAnswer } from '../state.ts'
import { encodeBase64 } from './base64.ts'

/** Pack one answer into the base64 token `mol4agent_inspect` expects. */
export async function encodeInspectAnswer(answer: MolInspectAnswer): Promise<string> {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('this browser cannot compress the inspection answer')
  }
  const bytes = new TextEncoder().encode(JSON.stringify(answer))
  const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))
  const packed = new Uint8Array(await new Response(stream).arrayBuffer())
  return encodeBase64(packed)
}
