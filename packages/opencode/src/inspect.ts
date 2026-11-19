/**
 * Inspection and TM-score rendezvous. Both are read-only queries: the agent
 * asks, the GUI samples the live Mol* viewer, and answers through RPC.
 *
 * A query is queued even when the GUI is not mounted yet: the panel claims
 * pending queries when it mounts or when the routed session changes, just like
 * captures. The waiting tool call and the GUI can also race, so a delivery
 * that arrives just before `wait` is kept briefly for its waiter.
 *
 * @module @gcszhn/mol4agent-opencode/inspect
 */
import { randomUUID } from 'node:crypto'
import type {
  InspectRequest,
  InspectResult,
  TmScoreRequest,
  TmScoreResult,
} from '@gcszhn/mol4agent-core/protocol'
import type { SceneSnapshot } from './scene.ts'

/** The viewer's answer to an inspection. */
export type InspectAnswer =
  | { readonly ok: true; readonly result: InspectResult }
  | { readonly ok: false; readonly message: string }

/** The viewer's answer to a TM-score query. */
export type TmScoreAnswer =
  | { readonly ok: true; readonly result: TmScoreResult }
  | { readonly ok: false; readonly message: string }

/** One read-only query waiting for the GUI to read the live viewer. */
export interface PendingQuery<TRequest> {
  readonly queryId: string
  readonly sessionID: string
  readonly scene: SceneSnapshot
  readonly request: TRequest
  readonly createdAt: number
}

export type PendingInspect = PendingQuery<InspectRequest>
export type PendingTmScore = PendingQuery<TmScoreRequest>

interface Waiter<TAnswer> {
  readonly resolve: (answer: TAnswer) => void
  readonly reject: (error: Error) => void
}

/** Deliveries can beat the tool to `wait`; keep them briefly for that waiter. */
const EARLY_ANSWER_TTL_MS = 30_000

/** Queue of pending queries plus the tool promises waiting on them. */
export class QueryHub<TRequest, TAnswer> {
  private readonly pending: PendingQuery<TRequest>[] = []
  private readonly waiters = new Map<string, Waiter<TAnswer>>()
  private readonly early = new Map<string, { readonly answer: TAnswer; readonly timer: ReturnType<typeof setTimeout> }>()
  private readonly timeoutMessage: string

  constructor(timeoutMessage: string) {
    this.timeoutMessage = timeoutMessage
  }

  enqueue(input: {
    readonly sessionID: string
    readonly scene: SceneSnapshot
    readonly request: TRequest
  }): PendingQuery<TRequest> {
    const query: PendingQuery<TRequest> = {
      queryId: randomUUID(),
      sessionID: input.sessionID,
      scene: input.scene,
      request: input.request,
      createdAt: Date.now(),
    }
    this.pending.push(query)
    return query
  }

  /** Pending queries for one session, for a GUI that mounts mid-query. */
  pendingForSession(sessionID: string): readonly PendingQuery<TRequest>[] {
    return this.pending.filter(query => query.sessionID === sessionID)
  }

  wait(queryId: string, timeoutMs: number, signal: AbortSignal): Promise<TAnswer> {
    const early = this.early.get(queryId)
    if (early !== undefined) {
      clearTimeout(early.timer)
      this.early.delete(queryId)
      this.removePending(queryId)
      return Promise.resolve(early.answer)
    }
    if (signal.aborted) {
      this.removePending(queryId)
      return Promise.reject(new Error('viewer query was cancelled'))
    }
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
        resolve: answer => { settle(); resolve(answer) },
        reject: error => { settle(); reject(error) },
      })
    })
  }

  /** Reject a waiting query with a viewer-level failure. */
  fail(queryId: string, message: string): boolean {
    return this.deliver(queryId, { ok: false, message } as TAnswer)
  }

  /** Resolve one pending query with the GUI's answer. */
  deliver(queryId: string, answer: TAnswer): boolean {
    const waiter = this.waiters.get(queryId)
    if (waiter !== undefined) {
      this.removePending(queryId)
      waiter.resolve(answer)
      return true
    }
    // The query may have timed out or never existed. Only keep an early answer
    // while the query is still pending.
    if (!this.pending.some(query => query.queryId === queryId)) return false
    const previous = this.early.get(queryId)
    if (previous !== undefined) clearTimeout(previous.timer)
    const timer = setTimeout(() => { this.early.delete(queryId) }, EARLY_ANSWER_TTL_MS)
    // Do not keep a Node test process (or a shutdown) alive for the window.
    timer.unref?.()
    this.early.set(queryId, { answer, timer })
    return true
  }

  private removePending(queryId: string): void {
    const index = this.pending.findIndex(query => query.queryId === queryId)
    if (index >= 0) this.pending.splice(index, 1)
  }
}

/** Live-state inspection queries. */
export class InspectHub extends QueryHub<InspectRequest, InspectAnswer> {
  constructor() {
    super('the molecular viewer did not answer the query in time; '
      + 'open the structure with mol_open, keep its viewer tab open, and try again')
  }
}

/** Read-only TM-score queries. */
export class TmScoreHub extends QueryHub<TmScoreRequest, TmScoreAnswer> {
  constructor() {
    super('the molecular viewer did not answer the TM-score query in time; '
      + 'open the structure with mol_open, keep its viewer tab open, and try again')
  }
}

/**
 * Validate a delivered inspection answer at the RPC boundary.
 *
 * A malformed payload must not reach the formatter, which indexes `counts`,
 * `styles`, and `residueRows` unconditionally.
 */
export function inspectAnswerOf(value: unknown): InspectAnswer | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as { ok?: unknown; result?: unknown; message?: unknown }
  if (candidate.ok === true) {
    if (typeof candidate.result !== 'object' || candidate.result === null) return undefined
    const result = candidate.result as Partial<InspectResult>
    if (!Array.isArray(result.styles) || !Array.isArray(result.counts)) return undefined
    if (typeof result.target !== 'string' || typeof result.detail !== 'string') return undefined
    if (result.appearance !== undefined) {
      if (typeof result.appearance !== 'object' || result.appearance === null) return undefined
      if (!Array.isArray(result.appearance.overlays)) return undefined
    }
    if (result.selection !== undefined && result.selection.groups !== undefined
      && !Array.isArray(result.selection.groups)) return undefined
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
}

/** Validate one delivered TM-score answer. */
export function tmScoreAnswerOf(value: unknown): TmScoreAnswer | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as { ok?: unknown; result?: unknown; message?: unknown }
  if (candidate.ok === true) {
    if (typeof candidate.result !== 'object' || candidate.result === null) return undefined
    const result = candidate.result as Partial<TmScoreResult>
    if (
      result.method !== 'tm-align'
      || typeof result.reference !== 'string'
      || typeof result.target !== 'string'
      || typeof result.rmsd !== 'number'
      || typeof result.tmScoreA !== 'number'
      || typeof result.tmScoreB !== 'number'
      || typeof result.alignedLength !== 'number'
    ) return undefined
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
}
