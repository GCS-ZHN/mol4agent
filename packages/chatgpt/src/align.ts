/**
 * Alignment result rendezvous.
 *
 * `mol_align` appends a replayable `align` command and waits for the app that
 * executes it to report the metrics. The command stays in the scene log, so a
 * newly mounted tab reproduces the same superposition; its duplicate report is
 * simply ignored when no tool call is waiting.
 *
 * @module @gcszhn/mol4agent-chatgpt/align
 */
import type { AlignmentResult } from '@gcszhn/mol4agent-core/protocol'

export type AlignAnswer =
  | { readonly ok: true; readonly result: AlignmentResult }
  | { readonly ok: false; readonly message: string }

interface Waiter {
  readonly sceneId: string
  readonly commandIndex: number
  readonly resolve: (value: AlignAnswer) => void
  readonly reject: (error: Error) => void
}

/**
 * Waiters keyed by scene plus the index of the align command in the scene log.
 *
 * The index is unique and monotonic inside a scene, so a later scene revision
 * or a replay in another tab cannot accidentally satisfy an older call.
 */
export class AlignHub {
  private readonly waiters = new Map<string, Waiter>()

  wait(
    sceneId: string,
    commandIndex: number,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<AlignAnswer> {
    const key = requestKey(sceneId, commandIndex)
    if (signal.aborted) return Promise.reject(new Error('alignment request was cancelled'))
    if (this.waiters.has(key)) {
      return Promise.reject(new Error('an alignment is already pending for this scene command'))
    }
    return new Promise<AlignAnswer>((resolve, reject) => {
      const settle = (): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        this.waiters.delete(key)
      }
      const abort = (): void => {
        settle()
        reject(new Error('alignment request was cancelled'))
      }
      const timer = setTimeout(() => {
        settle()
        reject(new Error(
          'the molecular viewer did not report the alignment in time; '
          + 'open a structure with mol_open, keep its viewer tab open, and try again',
        ))
      }, timeoutMs)
      signal.addEventListener('abort', abort, { once: true })
      this.waiters.set(key, {
        sceneId,
        commandIndex,
        resolve: value => { settle(); resolve(value) },
        reject: error => { settle(); reject(error) },
      })
    })
  }

  deliver(sceneId: string, commandIndex: number, answer: AlignAnswer): boolean {
    const key = requestKey(sceneId, commandIndex)
    const waiter = this.waiters.get(key)
    if (waiter === undefined) return false
    this.waiters.delete(key)
    waiter.resolve(answer)
    return true
  }

  has(sceneId: string, commandIndex: number): boolean {
    return this.waiters.has(requestKey(sceneId, commandIndex))
  }
}

/** Decode the app's JSON answer for one alignment. */
export function decodeAlignPayload(encoded: string): AlignAnswer | undefined {
  try {
    const parsed: unknown = JSON.parse(encoded)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const candidate = parsed as { ok?: unknown; result?: unknown; message?: unknown }
    if (candidate.ok === true) {
      if (typeof candidate.result !== 'object' || candidate.result === null) return undefined
      const result = candidate.result as Partial<AlignmentResult>
      if (
        typeof result.rmsd !== 'number'
        || typeof result.alignedLength !== 'number'
        || typeof result.reference !== 'string'
        || typeof result.target !== 'string'
        || (result.method !== 'tm-align' && result.method !== 'sequence')
      ) {
        return undefined
      }
      return { ok: true, result: result as AlignmentResult }
    }
    if (candidate.ok === false) {
      return {
        ok: false,
        message: typeof candidate.message === 'string' && candidate.message !== ''
          ? candidate.message
          : 'the viewer could not align the structures',
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

function requestKey(sceneId: string, commandIndex: number): string {
  return `${sceneId}:${String(commandIndex)}`
}
