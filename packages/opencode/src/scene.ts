/**
 * The adapter-owned scene log, bucketed per session.
 *
 * OpenCode's server serves several sessions at once, so the scene log must not
 * be a single process-wide `active` tab: session A's `mol_open` must not open a
 * panel in session B, and one session's style must not change another's scene.
 * The store is therefore one process-wide object (`globalThis`, see server.ts)
 * holding a per-session bucket. Each bucket keeps path-keyed tabs so agent
 * tools can target a tab by path (`mol_style({ tab })`), and a global
 * `byId` map gives O(1) access to any scene by its unique id.
 *
 * @module @gcszhn/mol4agent-opencode/scene
 */
import { randomUUID } from 'node:crypto'
import type { MolCommand, MolFormat, StructureSummary } from '@gcszhn/mol4agent-core/protocol'
import { summarizeStructure } from '@gcszhn/mol4agent-core/parse'
import { bytesToBase64 } from './base64.ts'
import { isBinaryFormat } from './formats.ts'

/** JSON-safe scene description sent to the GUI. */
export interface SceneSnapshot {
  readonly sceneId: string
  readonly path: string
  readonly label: string
  readonly format: MolFormat
  readonly binary: boolean
  readonly revision: number
  readonly commands: readonly MolCommand[]
}

/** One open structure plus its bytes and cumulative command log. */
export interface SceneRecord {
  readonly sceneId: string
  readonly sessionID: string
  readonly path: string
  readonly label: string
  readonly format: MolFormat
  readonly binary: boolean
  readonly bytes: Uint8Array
  readonly commands: readonly MolCommand[]
  readonly revision: number
  /** Parsed once on open; used for early selector validation. */
  readonly summary?: StructureSummary
}

interface SessionState {
  readonly tabs: Map<string, SceneRecord>
  activePath: string | null
}

/** How many tabs one session keeps before the oldest non-active one is evicted. */
const MAX_TABS = 12

export class SceneStore {
  private readonly sessions = new Map<string, SessionState>()
  private readonly byId = new Map<string, SceneRecord>()

  private bucket(sessionID: string): SessionState {
    let state = this.sessions.get(sessionID)
    if (state === undefined) {
      state = { tabs: new Map(), activePath: null }
      this.sessions.set(sessionID, state)
    }
    return state
  }

  /** Create/replace the tab for `path`, make it active, and return its snapshot. */
  open(sessionID: string, input: {
    readonly path: string
    readonly label: string
    readonly format: MolFormat
    readonly bytes: Uint8Array
    readonly commands: readonly MolCommand[]
  }): SceneSnapshot {
    const state = this.bucket(sessionID)
    const previous = state.tabs.get(input.path)
    if (previous !== undefined) this.byId.delete(previous.sceneId)
    const summary = safeSummary(input.bytes, input.format)
    const record: SceneRecord = {
      sceneId: randomUUID(),
      sessionID,
      path: input.path,
      label: input.label,
      format: input.format,
      binary: isBinaryFormat(input.format),
      bytes: input.bytes,
      commands: input.commands,
      revision: 1,
      ...(summary === undefined ? {} : { summary }),
    }
    state.tabs.set(input.path, record)
    this.byId.set(record.sceneId, record)
    state.activePath = input.path
    this.evict(state, input.path)
    return snapshotOf(record)
  }

  /** Append one command to a tab (or the active tab when `path` is omitted). */
  push(sessionID: string, path: string | null, command: MolCommand): SceneSnapshot | null {
    const state = this.bucket(sessionID)
    const target = path ?? state.activePath
    if (target === null) return null
    const current = state.tabs.get(target)
    if (current === undefined) return null
    const record: SceneRecord = {
      ...current,
      commands: [...current.commands, command],
      revision: current.revision + 1,
    }
    state.tabs.set(target, record)
    this.byId.set(record.sceneId, record)
    return snapshotOf(record)
  }

  /** The active tab path for a session, or null. */
  active(sessionID: string): string | null {
    return this.bucket(sessionID).activePath
  }

  /** Snapshot of a tab (or the active tab when `path` is omitted). */
  snapshot(sessionID: string, path: string | null): SceneSnapshot | null {
    const state = this.bucket(sessionID)
    const target = path ?? state.activePath
    if (target === null) return null
    const record = state.tabs.get(target)
    return record === undefined ? null : snapshotOf(record)
  }

  /** Full record for a scene id, used to fetch bytes. */
  recordBySceneId(sceneId: string): SceneRecord | undefined {
    return this.byId.get(sceneId)
  }

  /** Lightweight list of one session's open scenes, for the GUI panel. */
  list(sessionID: string): { readonly active: string; readonly scenes: readonly SceneSnapshot[] } {
    const state = this.bucket(sessionID)
    return {
      active: state.activePath ?? '',
      scenes: [...state.tabs.values()].map(snapshotOf),
    }
  }

  /** Bytes + metadata for one scene, base64-encoded for the RPC wire. */
  fetch(
    sceneId: string,
    sessionID?: string,
  ): { sceneId: string; format: MolFormat; label: string; binary: boolean; data: string } | undefined {
    const record = this.byId.get(sceneId)
    if (record === undefined) return undefined
    // `sceneId` is a UUID, but validate it against the caller's bucket anyway:
    // a stale GUI state must not read another session's bytes.
    if (sessionID !== undefined && record.sessionID !== sessionID) return undefined
    return {
      sceneId: record.sceneId,
      format: record.format,
      label: record.label,
      binary: record.binary,
      data: bytesToBase64(record.bytes),
    }
  }

  private evict(state: SessionState, keepPath: string): void {
    while (state.tabs.size > MAX_TABS) {
      let evicted = false
      for (const path of state.tabs.keys()) {
        if (path === keepPath || path === state.activePath) continue
        const record = state.tabs.get(path)
        if (record !== undefined) this.byId.delete(record.sceneId)
        state.tabs.delete(path)
        evicted = true
        break
      }
      if (!evicted) return
    }
  }
}

function snapshotOf(record: SceneRecord): SceneSnapshot {
  return {
    sceneId: record.sceneId,
    path: record.path,
    label: record.label,
    format: record.format,
    binary: record.binary,
    revision: record.revision,
    commands: record.commands,
  }
}

function safeSummary(bytes: Uint8Array, format: MolFormat): StructureSummary | undefined {
  try {
    return summarizeStructure({ data: bytes, format })
  } catch {
    return undefined
  }
}
