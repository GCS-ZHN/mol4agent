/**
 * Decode the browser's inspection answer.
 *
 * The answer is plain data (residue/atom rows can reach hundreds of kilobytes),
 * so the browser gzips and base64-encodes it before it becomes a command input.
 * Compression here is transport only, matching the structure-file path.
 *
 * @module @gcszhn/mol4agent-deepseekharness/host/inspect-payload
 */
import { gunzipSync } from 'node:zlib'
import type { MolInspectAnswer } from '../state.ts'
import type { InspectResult } from '@gcszhn/mol4agent-core/protocol'

/** Decompressed answer budget: an inspection result, not a structure file. */
export const MAX_INSPECT_PAYLOAD_BYTES = 16 * 1024 * 1024

/** Decode one `mol4agent_inspect` payload, or undefined when it is unusable. */
export function decodeInspectPayload(encoded: string): MolInspectAnswer | undefined {
  try {
    const compressed = Buffer.from(encoded, 'base64')
    const json = gunzipSync(compressed, { maxOutputLength: MAX_INSPECT_PAYLOAD_BYTES }).toString('utf8')
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const candidate = parsed as { ok?: unknown; result?: unknown; message?: unknown }
    if (candidate.ok === true) {
      if (typeof candidate.result !== 'object' || candidate.result === null) return undefined
      // The formatter indexes these arrays unconditionally; a malformed result
      // is a bad delivery, not a reason to throw inside a tool call.
      const result = candidate.result as Partial<InspectResult>
      if (!Array.isArray(result.styles) || !Array.isArray(result.counts)) return undefined
      return { ok: true, result: result as InspectResult }
    }
    if (candidate.ok === false) {
      return {
        ok: false,
        message: typeof candidate.message === 'string' && candidate.message !== ''
          ? candidate.message
          : 'the viewer could not answer the query',
      }
    }
    return undefined
  } catch {
    return undefined
  }
}
