/**
 * Screenshot rendezvous.
 *
 * `mol_capture` enqueues a request and waits. The open app long-polls, claims
 * the request, renders the viewport, and commits the PNG. This keeps the model
 * tool call synchronous (the image is in the same tool result) while the actual
 * WebGL render happens in the app.
 *
 * @module @gcszhn/mol4agent-chatgpt/capture
 */
import { randomUUID } from 'node:crypto'
import type { SceneSnapshot } from './scene.ts'

/** One capture waiting for the app to render it. */
export interface PendingCapture {
  readonly captureId: string
  readonly scene: SceneSnapshot
  readonly width: number
  readonly height: number
  readonly transparent: boolean
  readonly createdAt: number
}

/** A delivered PNG plus the app's optional diagnostics. */
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

/** Queue of pending captures keyed by scene plus the waiting tool promises. */
export class CaptureHub {
  private readonly pending: PendingCapture[] = []
  private readonly waiters = new Map<string, Waiter>()

  /** Enqueue a capture and return the request the app will claim. */
  enqueue(input: {
    readonly scene: SceneSnapshot
    readonly width: number
    readonly height: number
    readonly transparent: boolean
  }): PendingCapture {
    const capture: PendingCapture = {
      captureId: randomUUID(),
      scene: input.scene,
      width: input.width,
      height: input.height,
      transparent: input.transparent,
      createdAt: Date.now(),
    }
    this.pending.push(capture)
    return capture
  }

  /** Claim the oldest capture for a scene (or any scene when omitted). */
  claim(sceneId?: string): PendingCapture | null {
    const index = this.pending.findIndex(capture => sceneId === undefined || capture.scene.sceneId === sceneId)
    if (index < 0) return null
    return this.pending.splice(index, 1)[0] ?? null
  }

  /** Wait for the app to deliver or reject one capture. */
  wait(captureId: string, timeoutMs: number, signal: AbortSignal): Promise<CaptureDelivery> {
    if (signal.aborted) return Promise.reject(new Error('capture request was cancelled'))
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

  /** Resolve a waiting capture with a rendered PNG. */
  deliver(captureId: string, delivery: CaptureDelivery): boolean {
    const waiter = this.waiters.get(captureId)
    this.removePending(captureId)
    if (waiter === undefined) return false
    waiter.resolve(delivery)
    return true
  }

  /** Fail a waiting capture with a model-readable reason. */
  fail(captureId: string, message: string): boolean {
    const waiter = this.waiters.get(captureId)
    this.removePending(captureId)
    if (waiter === undefined) return false
    waiter.reject(new Error(message))
    return true
  }

  /** Pending captures are visible to the app for long-polling. */
  hasPending(sceneId?: string): boolean {
    return this.pending.some(capture => sceneId === undefined || capture.scene.sceneId === sceneId)
  }

  private removePending(captureId: string): void {
    const index = this.pending.findIndex(capture => capture.captureId === captureId)
    if (index >= 0) this.pending.splice(index, 1)
  }
}
