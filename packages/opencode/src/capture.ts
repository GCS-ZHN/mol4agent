/**
 * Screenshot rendezvous. `mol_capture` enqueues a request and waits; the GUI
 * renders the viewport and commits the PNG through RPC. This keeps the model
 * tool call synchronous while the WebGL render happens in the viewer panel.
 *
 * @module @gcszhn/mol4agent-opencode/capture
 */
import { randomUUID } from 'node:crypto'
import type { SceneSnapshot } from './scene.ts'

/** One capture waiting for the GUI to render it. */
export interface PendingCapture {
  readonly captureId: string
  readonly sessionID: string
  readonly scene: SceneSnapshot
  readonly width: number
  readonly height: number
  readonly transparent: boolean
  /** Directory the PNG is saved under once delivered. */
  readonly saveDir: string
  readonly createdAt: number
}

/** A delivered PNG plus the GUI's optional diagnostics. */
export interface CaptureDelivery {
  readonly png: Uint8Array
  readonly width: number
  readonly height: number
  readonly path: string
  readonly diagnostics?: Record<string, unknown>
}

interface Waiter {
  readonly resolve: (value: CaptureDelivery) => void
  readonly reject: (error: Error) => void
}

/** Queue of pending captures plus the waiting tool promises. */
export class CaptureHub {
  private readonly pending: PendingCapture[] = []
  private readonly waiters = new Map<string, Waiter>()

  enqueue(input: {
    readonly sessionID: string
    readonly scene: SceneSnapshot
    readonly width: number
    readonly height: number
    readonly transparent: boolean
    readonly saveDir: string
  }): PendingCapture {
    const capture: PendingCapture = {
      captureId: randomUUID(),
      sessionID: input.sessionID,
      scene: input.scene,
      width: input.width,
      height: input.height,
      transparent: input.transparent,
      saveDir: input.saveDir,
      createdAt: Date.now(),
    }
    this.pending.push(capture)
    return capture
  }

  /** The save directory of a pending capture, if it is still queued. */
  saveDirOf(captureId: string): string | undefined {
    return this.pending.find(capture => capture.captureId === captureId)?.saveDir
  }

  /** Pending captures for one session, for a GUI that (re)mounts mid-capture. */
  pendingForSession(sessionID: string): readonly PendingCapture[] {
    return this.pending.filter(capture => capture.sessionID === sessionID)
  }

  wait(captureId: string, timeoutMs: number, signal: AbortSignal): Promise<CaptureDelivery> {
    if (signal.aborted) {
      this.removePending(captureId)
      return Promise.reject(new Error('capture request was cancelled'))
    }
    return new Promise<CaptureDelivery>((resolve, reject) => {
      const settle = (): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        this.waiters.delete(captureId)
      }
      const abort = (): void => {
        settle()
        this.removePending(captureId)
        reject(new Error('capture request was cancelled'))
      }
      const timer = setTimeout(() => {
        settle()
        this.removePending(captureId)
        reject(new Error(
          'the molecular viewer did not deliver a screenshot in time; '
          + 'open a structure with mol_open, keep its viewer visible, and try again',
        ))
      }, timeoutMs)
      signal.addEventListener('abort', abort, { once: true })
      this.waiters.set(captureId, {
        resolve: value => { settle(); resolve(value) },
        reject: error => { settle(); reject(error) },
      })
    })
  }

  deliver(captureId: string, delivery: CaptureDelivery): boolean {
    const waiter = this.waiters.get(captureId)
    this.removePending(captureId)
    if (waiter === undefined) return false
    waiter.resolve(delivery)
    return true
  }

  fail(captureId: string, message: string): boolean {
    const waiter = this.waiters.get(captureId)
    this.removePending(captureId)
    if (waiter === undefined) return false
    waiter.reject(new Error(message))
    return true
  }

  private removePending(captureId: string): void {
    const index = this.pending.findIndex(capture => capture.captureId === captureId)
    if (index >= 0) this.pending.splice(index, 1)
  }
}
