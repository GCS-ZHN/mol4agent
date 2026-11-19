/**
 * Live-viewer query rendezvous and result transport.
 *
 * `mol_inspect` and `mol_tmscore` enqueue read-only queries and wait. The
 * already-mounted agent tab claims them from its normal long poll, samples the
 * live Mol* state, and commits the answer through an app-only tool. A viewer
 * failure is delivered as `{ ok: false }` so the tool reports a model-readable
 * reason instead of waiting for its timeout.
 *
 * Inspection answers grow with the requested detail, so the app gzips and
 * base64-encodes them. TM-score answers are tiny and travel as plain JSON.
 *
 * @module @gcszhn/mol4agent-chatgpt/inspect
 */
import { randomUUID } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import type {
  InspectRequest,
  InspectResult,
  TmScoreRequest,
  TmScoreResult,
} from '@gcszhn/mol4agent-core/protocol'

/** One read-only query waiting for the app that owns its scene. */
export interface PendingQuery<TRequest> {
  readonly queryId: string
  readonly sceneId: string
  readonly request: TRequest
  readonly createdAt: number
}

export type PendingInspect = PendingQuery<InspectRequest>
export type PendingTmScore = PendingQuery<TmScoreRequest>

export type InspectAnswer =
  | { readonly ok: true; readonly result: InspectResult }
  | { readonly ok: false; readonly message: string }

export type TmScoreAnswer =
  | { readonly ok: true; readonly result: TmScoreResult }
  | { readonly ok: false; readonly message: string }

/** Decompressed inspection budget: a result, not a structure file. */
export const MAX_INSPECT_PAYLOAD_BYTES = 16 * 1024 * 1024

interface Waiter<TAnswer> {
  readonly resolve: (value: TAnswer) => void
  readonly reject: (error: Error) => void
}

/**
 * Queue of pending queries plus the parked tool calls.
 *
 * Claims are scoped by scene id so a file-viewer tab can never answer a query
 * about the active agent scene, and an older agent tab never answers for a
 * structure it does not show.
 */
export class QueryHub<TRequest, TAnswer> {
  private readonly pending: PendingQuery<TRequest>[] = []
  private readonly waiters = new Map<string, Waiter<TAnswer>>()
  private readonly timeoutMessage: string

  constructor(timeoutMessage: string) {
    this.timeoutMessage = timeoutMessage
  }

  enqueue(sceneId: string, request: TRequest): PendingQuery<TRequest> {
    const query: PendingQuery<TRequest> = {
      queryId: randomUUID(),
      sceneId,
      request,
      createdAt: Date.now(),
    }
    this.pending.push(query)
    return query
  }

  claim(sceneId?: string): PendingQuery<TRequest> | null {
    const index = this.pending.findIndex(query => sceneId === undefined || query.sceneId === sceneId)
    if (index < 0) return null
    return this.pending.splice(index, 1)[0] ?? null
  }

  wait(queryId: string, timeoutMs: number, signal: AbortSignal): Promise<TAnswer> {
    if (signal.aborted) return Promise.reject(new Error('viewer query was cancelled'))
    return new Promise<TAnswer>((resolve, reject) => {
      const settle = (): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        this.waiters.delete(queryId)
      }
      const abort = (): void => {
        settle()
        this.removePending(queryId)
        reject(new Error('viewer query was cancelled'))
      }
      const timer = setTimeout(() => {
        settle()
        this.removePending(queryId)
        reject(new Error(this.timeoutMessage))
      }, timeoutMs)
      signal.addEventListener('abort', abort, { once: true })
      this.waiters.set(queryId, {
        resolve: value => { settle(); resolve(value) },
        reject: error => { settle(); reject(error) },
      })
    })
  }

  deliver(queryId: string, answer: TAnswer): boolean {
    const waiter = this.waiters.get(queryId)
    this.removePending(queryId)
    if (waiter === undefined) return false
    waiter.resolve(answer)
    return true
  }

  fail(queryId: string, message: string): boolean {
    return this.deliver(queryId, { ok: false, message } as TAnswer)
  }

  hasPending(sceneId?: string): boolean {
    return this.pending.some(query => sceneId === undefined || query.sceneId === sceneId)
  }

  private removePending(queryId: string): void {
    const index = this.pending.findIndex(query => query.queryId === queryId)
    if (index >= 0) this.pending.splice(index, 1)
  }
}

/** Inspection queries: text rows can reach megabytes. */
export class InspectHub extends QueryHub<InspectRequest, InspectAnswer> {
  constructor() {
    super('the molecular viewer did not answer the inspection in time; '
      + 'open a structure with mol_open, keep its viewer tab open, and try again')
  }
}

/** Read-only TM-score queries. */
export class TmScoreHub extends QueryHub<TmScoreRequest, TmScoreAnswer> {
  constructor() {
    super('the molecular viewer did not answer the TM-score query in time; '
      + 'open a structure with mol_open, keep its viewer tab open, and try again')
  }
}

/** Decode one gzip+base64 inspection answer. */
export function decodeInspectPayload(encoded: string): InspectAnswer | undefined {
  try {
    const compressed = Buffer.from(encoded, 'base64')
    const json = gunzipSync(compressed, { maxOutputLength: MAX_INSPECT_PAYLOAD_BYTES }).toString('utf8')
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const candidate = parsed as { ok?: unknown; result?: unknown; message?: unknown }
    if (candidate.ok === true) {
      if (typeof candidate.result !== 'object' || candidate.result === null) return undefined
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

/** Decode one plain-JSON TM-score answer. */
export function decodeTmScorePayload(encoded: string): TmScoreAnswer | undefined {
  try {
    const parsed: unknown = JSON.parse(encoded)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const candidate = parsed as { ok?: unknown; result?: unknown; message?: unknown }
    if (candidate.ok === true) {
      if (typeof candidate.result !== 'object' || candidate.result === null) return undefined
      const result = candidate.result as Partial<TmScoreResult>
      if (
        typeof result.rmsd !== 'number'
        || typeof result.tmScoreA !== 'number'
        || typeof result.tmScoreB !== 'number'
        || typeof result.alignedLength !== 'number'
      ) {
        return undefined
      }
      return { ok: true, result: result as TmScoreResult }
    }
    if (candidate.ok === false) {
      return {
        ok: false,
        message: typeof candidate.message === 'string' && candidate.message !== ''
          ? candidate.message
          : 'the viewer could not compute a TM-score',
      }
    }
    return undefined
  } catch {
    return undefined
  }
}
