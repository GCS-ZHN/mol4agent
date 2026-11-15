/**
 * Pure routing decisions for the GUI's session/event/capture handling. Kept
 * free of Solid, DOM, and the OpenCode SDK so the lifecycle rules are unit
 * testable without a running app.
 *
 * @module @gcszhn/mol4agent-opencode/gui/routing
 */

/** Minimal scene shape the GUI stores per session. */
export interface SceneLike {
  readonly path: string
  readonly sceneId: string
  readonly label: string
}

/** A `scene` RPC event, as the server emits it. */
export interface SceneEventLike {
  readonly sessionID?: string
  readonly path?: string
  readonly open?: boolean
}

export type SceneRoute =
  /** Another session changed without opening a structure: nothing to do now. */
  | { readonly action: 'ignore' }
  /** A structure was opened in another session: open it after routing there. */
  | { readonly action: 'queue'; readonly sessionID: string; readonly path: string }
  /** The routed session changed (or opened a structure): refresh its scenes. */
  | { readonly action: 'refresh'; readonly sessionID: string; readonly path?: string }

/** Index a scene list by path (the panel tab id). */
export function mergeScenes<T extends SceneLike>(scenes: readonly T[]): Record<string, T> {
  const byPath: Record<string, T> = {}
  for (const scene of scenes) byPath[scene.path] = scene
  return byPath
}

/** The scene for one session and panel tab; never falls back across sessions. */
export function selectScene<T>(
  bySession: Record<string, Record<string, T>>,
  sessionID: string,
  path: string,
): T | undefined {
  return bySession[sessionID]?.[path]
}

/**
 * Decide what a `scene` event means for the routed session. `open` events for
 * another session are queued so switching there reveals the structure; other
 * events for another session are irrelevant until that session is routed.
 */
export function routeSceneEvent(currentSessionID: string, event: SceneEventLike | undefined): SceneRoute {
  const sessionID = event?.sessionID ?? currentSessionID
  const openedPath = event?.open === true ? event.path : undefined
  if (sessionID === currentSessionID) {
    return openedPath === undefined
      ? { action: 'refresh', sessionID }
      : { action: 'refresh', sessionID, path: openedPath }
  }
  return openedPath === undefined
    ? { action: 'ignore' }
    : { action: 'queue', sessionID, path: openedPath }
}

export type CaptureDecision =
  /** The routed session changed; leave the capture pending for a later claim. */
  | 'leave-pending'
  /** The session still matches but no viewer mounted: fail with a message. */
  | 'fail'
  /** Deliver through this session's viewer. */
  | 'deliver'

/** Whether a capture may be delivered under the currently routed session. */
export function captureDecision(captureSessionID: string, currentSessionID: string, viewerReady: boolean): CaptureDecision {
  if (captureSessionID !== currentSessionID) return 'leave-pending'
  return viewerReady ? 'deliver' : 'fail'
}
