/**
 * Session + tool-call keyed rendezvous between a blocking Host tool and the
 * browser page that answers it.
 *
 * The browser sees a pending request in the session projection and calls an
 * internal session command with the answer; the tool is parked here until that
 * answer arrives. Screenshots and inspection queries share this machinery but
 * deliver different payloads.
 *
 * @module @gcszhn/mol4agent-deepseekharness/host/pending
 */
import type { SessionId } from '@deepseek-ai/dsh-session'

interface Waiter<T> {
  readonly resolve: (value: T) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly abort: () => void
  readonly signal: AbortSignal
}

/** Rendezvous keyed by session and tool call id. */
export class PendingRequests<T> {
  private readonly waiters = new Map<string, Waiter<T>>()
  /** Deliveries that beat the tool to `wait`; kept briefly for the same rendezvous. */
  private readonly early = new Map<string, { value: T; timer: ReturnType<typeof setTimeout> }>()
  private disposed = false

  /** Message reported when the page never answers; wording is caller-specific. */
  private readonly timeoutMessage: string

  constructor(timeoutMessage: string) {
    this.timeoutMessage = timeoutMessage
  }

  wait(sessionId: SessionId, callId: string, timeoutMs: number, signal: AbortSignal): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('mol4agent is unloading'))
    const key = requestKey(sessionId, callId)
    const early = this.early.get(key)
    if (early !== undefined) {
      clearTimeout(early.timer)
      this.early.delete(key)
      return Promise.resolve(early.value)
    }
    if (this.waiters.has(key)) return Promise.reject(new Error(`a request is already pending for ${callId}`))
    return new Promise<T>((resolve, reject) => {
      const settleReject = (error: Error): void => {
        const waiter = this.waiters.get(key)
        if (waiter === undefined) return
        this.waiters.delete(key)
        clearTimeout(waiter.timer)
        signal.removeEventListener('abort', waiter.abort)
        reject(error)
      }
      const abort = (): void => { settleReject(new Error('the viewer request was cancelled')) }
      const timer = setTimeout(() => { settleReject(new Error(this.timeoutMessage)) }, timeoutMs)
      signal.addEventListener('abort', abort, { once: true })
      this.waiters.set(key, { resolve, reject, timer, abort, signal })
    })
  }

  /** Resolve one pending request with the browser's answer. */
  deliver(sessionId: SessionId, callId: string, value: T): boolean {
    // After unload nobody can consume a delivery; do not park a timer that
    // keeps a process (or a test runner) alive for the whole early window.
    if (this.disposed) return true
    const key = requestKey(sessionId, callId)
    const waiter = this.waiters.get(key)
    if (waiter === undefined) {
      const previous = this.early.get(key)
      if (previous !== undefined) clearTimeout(previous.timer)
      const timer = setTimeout(() => { this.early.delete(key) }, 30_000)
      this.early.set(key, { value, timer })
      return true
    }
    this.waiters.delete(key)
    clearTimeout(waiter.timer)
    waiter.signal.removeEventListener('abort', waiter.abort)
    waiter.resolve(value)
    return true
  }

  /** Reject every pending request on unload. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const [key, waiter] of this.waiters) {
      this.waiters.delete(key)
      clearTimeout(waiter.timer)
      waiter.signal.removeEventListener('abort', waiter.abort)
      waiter.reject(new Error('mol4agent is unloading'))
    }
    for (const entry of this.early.values()) clearTimeout(entry.timer)
    this.early.clear()
  }
}

function requestKey(sessionId: SessionId, callId: string): string {
  return `${String(sessionId)}:${callId}`
}
