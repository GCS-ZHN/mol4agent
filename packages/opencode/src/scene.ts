/**
 * The adapter-owned scene log. A scene stores the file bytes once and a
 * cumulative list of JSON commands, so any viewer instance can rebuild the
 * current picture from a snapshot without observing earlier tool calls.
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

/**
 * In-memory scene store. Agent tools mutate the active scene (the last
 * `mol_open`); every opened path keeps its own independent tab scene, so a new
 * open never replaces an older tab's structure.
 */
export class SceneStore {
  private readonly tabs = new Map<string, SceneRecord>()
  private readonly byId = new Map<string, string>()
  private activePath: string | null = null

  /** Create/replace the tab for `path`, make it active, and return its snapshot. */
  open(input: {
    readonly path: string
    readonly label: string
    readonly format: MolFormat
    readonly bytes: Uint8Array
    readonly commands: readonly MolCommand[]
  }): SceneSnapshot {
    const summary = safeSummary(input.bytes, input.format)
    const record: SceneRecord = {
      sceneId: randomUUID(),
      path: input.path,
      label: input.label,
      format: input.format,
      binary: isBinaryFormat(input.format),
      bytes: input.bytes,
      commands: input.commands,
      revision: 1,
      ...(summary === undefined ? {} : { summary }),
    }
    this.tabs.set(input.path, record)
    this.byId.set(record.sceneId, input.path)
    this.activePath = input.path
    return snapshotOf(record)
  }

  /** Append one command to the active scene. Returns null when nothing is open. */
  pushActive(command: MolCommand): SceneSnapshot | null {
    if (this.activePath === null) return null
    const current = this.tabs.get(this.activePath)
    if (current === undefined) return null
    const record: SceneRecord = {
      ...current,
      commands: [...current.commands, command],
      revision: current.revision + 1,
    }
    this.tabs.set(this.activePath, record)
    return snapshotOf(record)
  }

  /** The active scene's path, or null. */
  active(): string | null {
    return this.activePath
  }

  /** Snapshot of the active scene, if any. */
  snapshotActive(): SceneSnapshot | null {
    if (this.activePath === null) return null
    const record = this.tabs.get(this.activePath)
    return record === undefined ? null : snapshotOf(record)
  }

  /** Full record for a scene id, used to fetch bytes. */
  recordBySceneId(sceneId: string): SceneRecord | undefined {
    const path = this.byId.get(sceneId)
    return path === undefined ? undefined : this.tabs.get(path)
  }

  /** Lightweight list of every open scene, for the GUI panel. */
  list(): { readonly active: string; readonly scenes: readonly SceneSnapshot[] } {
    return {
      active: this.activePath ?? '',
      scenes: [...this.tabs.values()].map(snapshotOf),
    }
  }

  /** Bytes + metadata for one scene, base64-encoded for the RPC wire. */
  fetch(sceneId: string): { sceneId: string; format: MolFormat; label: string; binary: boolean; data: string } | undefined {
    const record = this.recordBySceneId(sceneId)
    if (record === undefined) return undefined
    return {
      sceneId: record.sceneId,
      format: record.format,
      label: record.label,
      binary: record.binary,
      data: bytesToBase64(record.bytes),
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
