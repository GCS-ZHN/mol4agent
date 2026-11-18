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
 * One tab can hold several structures (core's multi-structure scene). The
 * `structure` id is always the one created by `mol_open`/`openPath`; extra ones
 * come from `mol_add_structure`. Removed structures stay in the list so a new
 * viewer can replay the removal command, but `activeStructures` filters them
 * for tools.
 *
 * @module @gcszhn/mol4agent-opencode/scene
 */
import { randomUUID } from 'node:crypto'
import type { MolCommand, MolFormat, StructureSummary } from '@gcszhn/mol4agent-core/protocol'
import { summarizeStructure } from '@gcszhn/mol4agent-core/parse'
import { bytesToBase64 } from './base64.ts'
import { isBinaryFormat } from './formats.ts'

/** JSON-safe metadata for one structure in a scene. */
export interface SceneStructureSnapshot {
  readonly id: string
  readonly path: string
  readonly label: string
  readonly format: MolFormat
  readonly binary: boolean
}

/** One structure plus its bytes and parsed summary. */
export interface SceneStructureRecord extends SceneStructureSnapshot {
  readonly bytes: Uint8Array
  readonly summary?: StructureSummary
}

/** JSON-safe scene description sent to the GUI. */
export interface SceneSnapshot {
  readonly sceneId: string
  /** Primary structure path; also the panel tab id. */
  readonly path: string
  readonly label: string
  readonly format: MolFormat
  readonly binary: boolean
  readonly revision: number
  readonly commands: readonly MolCommand[]
  /** Every structure ever added to this scene, in add order. */
  readonly structures: readonly SceneStructureSnapshot[]
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
  /** The primary structure and every structure added later. */
  readonly structures: readonly SceneStructureRecord[]
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
    const primary = structureRecord('structure', input)
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
      structures: [primary],
      ...(primary.summary === undefined ? {} : { summary: primary.summary }),
    }
    state.tabs.set(input.path, record)
    this.byId.set(record.sceneId, record)
    state.activePath = input.path
    this.evict(state, input.path)
    return snapshotOf(record)
  }

  /**
   * Add a structure to a tab without replacing its existing structures.
   *
   * The id must be unique across every structure ever added to the tab:
   * commands replay from the full list, so reusing an id after removal would
   * make the replayed hierarchy ambiguous.
   */
  addStructure(sessionID: string, path: string | null, input: {
    readonly id: string
    readonly path: string
    readonly label: string
    readonly format: MolFormat
    readonly bytes: Uint8Array
  }): SceneSnapshot | null {
    const state = this.bucket(sessionID)
    const target = path ?? state.activePath
    if (target === null) return null
    const current = state.tabs.get(target)
    if (current === undefined) return null
    if (current.structures.some(structure => structure.id === input.id)) {
      throw new Error(`structure id "${input.id}" is already used in this scene; choose another id`)
    }
    const structure = structureRecord(input.id, input)
    const record: SceneRecord = {
      ...current,
      structures: [...current.structures, structure],
      revision: current.revision + 1,
    }
    state.tabs.set(target, record)
    this.byId.set(record.sceneId, record)
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

  /** One structure record by id, defaulting to the primary. */
  structure(sceneId: string, structureId = 'structure'): SceneStructureRecord | undefined {
    const record = this.byId.get(sceneId)
    return record?.structures.find(structure => structure.id === structureId)
  }

  /** Lightweight list of one session's open scenes, for the GUI panel. */
  list(sessionID: string): { readonly active: string; readonly scenes: readonly SceneSnapshot[] } {
    const state = this.bucket(sessionID)
    return {
      active: state.activePath ?? '',
      scenes: [...state.tabs.values()].map(snapshotOf),
    }
  }

  /** Bytes + metadata for the primary structure of a scene, for the RPC wire. */
  fetch(
    sceneId: string,
    sessionID?: string,
  ): { sceneId: string; structureId: string; format: MolFormat; label: string; binary: boolean; data: string } | undefined {
    return this.fetchStructure(sceneId, 'structure', sessionID)
  }

  /** Bytes + metadata for one structure, base64-encoded for the RPC wire. */
  fetchStructure(
    sceneId: string,
    structureId: string,
    sessionID?: string,
  ): { sceneId: string; structureId: string; format: MolFormat; label: string; binary: boolean; data: string } | undefined {
    const record = this.byId.get(sceneId)
    if (record === undefined) return undefined
    // `sceneId` is a UUID, but validate it against the caller's bucket anyway:
    // a stale GUI state must not read another session's bytes.
    if (sessionID !== undefined && record.sessionID !== sessionID) return undefined
    const structure = record.structures.find(candidate => candidate.id === structureId)
    if (structure === undefined) return undefined
    return {
      sceneId: record.sceneId,
      structureId: structure.id,
      format: structure.format,
      label: structure.label,
      binary: structure.binary,
      data: bytesToBase64(structure.bytes),
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

/** Structures still present after replaying every `remove-structure` command. */
export function activeStructures(scene: {
  readonly structures: readonly SceneStructureSnapshot[]
  readonly commands: readonly MolCommand[]
}): readonly SceneStructureSnapshot[] {
  const removed = new Set<string>()
  for (const command of scene.commands) {
    if (command.op === 'remove-structure') removed.add(command.structureId)
  }
  return scene.structures.filter(structure => !removed.has(structure.id))
}

/** Next generated structure id, skipping ids already used in the scene. */
export function nextStructureId(structures: readonly { readonly id: string }[]): string {
  const used = new Set(structures.map(structure => structure.id))
  for (let index = 2; ; index += 1) {
    const candidate = `structure-${String(index)}`
    if (!used.has(candidate)) return candidate
  }
}

function structureRecord(id: string, input: {
  readonly path: string
  readonly label: string
  readonly format: MolFormat
  readonly bytes: Uint8Array
}): SceneStructureRecord {
  const summary = safeSummary(input.bytes, input.format)
  return {
    id,
    path: input.path,
    label: input.label,
    format: input.format,
    binary: isBinaryFormat(input.format),
    bytes: input.bytes,
    ...(summary === undefined ? {} : { summary }),
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
    structures: record.structures.map(structure => ({
      id: structure.id,
      path: structure.path,
      label: structure.label,
      format: structure.format,
      binary: structure.binary,
    })),
  }
}

function safeSummary(bytes: Uint8Array, format: MolFormat): StructureSummary | undefined {
  try {
    return summarizeStructure({ data: bytes, format })
  } catch {
    return undefined
  }
}
