/**
 * Shared DSH adapter state. No Node, DOM, or Mol* imports, so both halves of
 * the bundle can use it.
 *
 * @module @gcszhn/mol4agent-deepseekharness/state
 */
import type { MolCommand, MolFormat } from '@gcszhn/mol4agent-core/protocol'
import type {} from '@deepseek-ai/dsh-session-projection/types'

/** Projection key owned by this adapter. */
export const PROJECTION_KEY = 'mol4agent'

/** One active viewer scene, in DSH semantics (path + suffix-derived format). */
export interface MolSceneState {
  /** Changes when the agent opens a file anew; drives a reload on the client. */
  readonly sceneKey: string
  /** Absolute path in the session's execution world. */
  readonly path: string
  readonly format: MolFormat
  readonly label: string
  /** Commands applied after the bytes load, in order. */
  readonly commands: readonly MolCommand[]
}

/** One screenshot the agent asked for, paired with the tool call waiting on it. */
export interface MolPendingCapture {
  readonly callId: string
  readonly width?: number
  readonly height?: number
  readonly transparent?: boolean
}

/** Whole client-visible projection value. */
export interface MolSessionState {
  readonly revision: number
  /** Session working directory captured at projection init; Host-only path resolution. */
  readonly cwd?: string
  readonly scene: MolSceneState | null
  readonly pending: Readonly<Record<string, MolPendingCapture>>
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Active molecular viewer scene plus pending screenshot requests. */
    mol4agent: MolSessionState
  }
}

/** Initial value before any molecule tool call. */
export const EMPTY_MOL_STATE: MolSessionState = { revision: 0, scene: null, pending: {} }
