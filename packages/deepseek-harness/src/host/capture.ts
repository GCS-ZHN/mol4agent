/**
 * Pending screenshot requests: a tool blocks here while the browser renders
 * the viewport and delivers the image through a session command.
 *
 * @module @gcszhn/mol4agent-deepseekharness/host/capture
 */
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** One delivered capture: the admitted image plus the browser's diagnostic report. */
export interface CaptureDelivery {
  readonly ref: ImageAttachmentRef
  readonly report?: Record<string, unknown>
}

interface Waiter {
  readonly resolve: (delivery: CaptureDelivery) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly abort: () => void
  readonly signal: AbortSignal
}

/** Session + tool-call keyed rendezvous between the tool and the browser. */
export class CaptureHub {
  private readonly waiters = new Map<string, Waiter>()
  /** Deliveries that beat the tool to `wait`; kept briefly for the same rendezvous. */
  private readonly early = new Map<string, { delivery: CaptureDelivery; timer: ReturnType<typeof setTimeout> }>()
  private disposed = false

  wait(sessionId: SessionId, callId: string, timeoutMs: number, signal: AbortSignal): Promise<CaptureDelivery> {
    if (this.disposed) return Promise.reject(new Error('mol4agent is unloading'))
    const key = captureKey(sessionId, callId)
    const early = this.early.get(key)
    if (early !== undefined) {
      clearTimeout(early.timer)
      this.early.delete(key)
      return Promise.resolve(early.delivery)
    }
    if (this.waiters.has(key)) return Promise.reject(new Error(`a capture is already pending for ${callId}`))
    return new Promise<CaptureDelivery>((resolve, reject) => {
      const settleReject = (error: Error): void => {
        const waiter = this.waiters.get(key)
        if (waiter === undefined) return
        this.waiters.delete(key)
        clearTimeout(waiter.timer)
        signal.removeEventListener('abort', waiter.abort)
        reject(error)
      }
      const abort = (): void => { settleReject(new Error('capture request was cancelled')) }
      const timer = setTimeout(() => {
        settleReject(new Error(
          'the molecular viewer did not deliver a screenshot in time; '
          + 'open the file preview for this structure and try again',
        ))
      }, timeoutMs)
      signal.addEventListener('abort', abort, { once: true })
      this.waiters.set(key, { resolve, reject, timer, abort, signal })
    })
  }

  /** Resolve one pending request with the admitted image. */
  deliver(sessionId: SessionId, callId: string, ref: ImageAttachmentRef, report?: Record<string, unknown>): boolean {
    const key = captureKey(sessionId, callId)
    const waiter = this.waiters.get(key)
    if (waiter === undefined) {
      const previous = this.early.get(key)
      if (previous !== undefined) clearTimeout(previous.timer)
      const timer = setTimeout(() => { this.early.delete(key) }, 30_000)
      this.early.set(key, { delivery: { ref, report }, timer })
      return true
    }
    this.waiters.delete(key)
    clearTimeout(waiter.timer)
    waiter.signal.removeEventListener('abort', waiter.abort)
    waiter.resolve({ ref, report })
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

function captureKey(sessionId: SessionId, callId: string): string {
  return `${String(sessionId)}:${callId}`
}

/**
 * A filesystem-safe file name for a persisted capture.
 *
 * DSH attachment ids look like `sha256:7dc1…`. `:` is illegal in a Windows
 * file name, and `writeFile` does not fail there: it writes the PNG into an
 * NTFS alternate data stream, leaving the reported path a zero-byte file.
 * Keep only alphanumerics, and take the tail so the digest still identifies
 * the image. The `mol4agent-` prefix also keeps Windows device names away.
 */
export function captureFileName(attachmentId: unknown, timestamp: number): string {
  const safeId = String(attachmentId).replace(/[^a-zA-Z0-9]/gu, '')
  const suffix = safeId.slice(-12) || 'image'
  return `mol4agent-${String(timestamp)}-${suffix}.png`
}
