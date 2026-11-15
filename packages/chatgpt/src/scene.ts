/**
 * The adapter-owned scene log.
 *
 * A scene stores the file bytes once and a cumulative list of JSON commands.
 * Every viewer instance can rebuild the current picture from a snapshot, so a
 * newly mounted app does not depend on having observed earlier tool calls.
 *
 * @module @gcszhn/mol4agent-chatgpt/scene
 */
import { randomUUID } from 'node:crypto'
import type { MolCommand, MolFormat, StructureSummary } from '@gcszhn/mol4agent-core/protocol'
import { summarizeStructure } from '@gcszhn/mol4agent-core/parse'

/** Where a scene came from; agent tools only mutate the agent scene. */
export type SceneSource = 'agent' | 'file'

/** JSON-safe scene description sent to the app and stored in tool results. */
export interface SceneSnapshot {
  readonly sceneId: string
  readonly revision: number
  readonly label: string
  readonly format: MolFormat
  readonly source: SceneSource
  /** Host resource URI for a file viewer; absent for agent-opened scenes. */
  readonly fileResourceUri?: string
  readonly commands: readonly MolCommand[]
}

/** One open structure plus its bytes and cumulative command log. */
export interface SceneRecord {
  readonly sceneId: string
  readonly path: string
  readonly label: string
  readonly format: MolFormat
  readonly source: SceneSource
  readonly bytes: Uint8Array
  readonly fileResourceUri?: string
  readonly commands: readonly MolCommand[]
  readonly revision: number
  /** Parsed once on open; used for early selector validation. */
  readonly summary?: StructureSummary
}

interface Waiter {
  readonly resolve: () => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly abort: () => void
  readonly signal: AbortSignal
}

const MAX_SCENES = 12

/**
 * In-memory scene store with a long-poll notification channel.
 *
 * The agent scene is the target of `mol_open`/`mol_style`/... . File-viewer
 * scenes are independent: opening a file from the tree must not replace or
 * mutate the agent's scene, and each file tab follows only its own scene.
 */
export class SceneStore {
  private agentScene: SceneRecord | null = null
  private readonly byId = new Map<string, SceneRecord>()
  private readonly listeners = new Set<() => void>()

  /** Replace the agent scene and return its initial snapshot. */
  openAgent(input: {
    readonly path: string
    readonly label: string
    readonly format: MolFormat
    readonly bytes: Uint8Array
    readonly commands: readonly MolCommand[]
  }): SceneSnapshot {
    return this.open(input, 'agent', true)
  }

  /** Add an independent file-viewer scene without touching the agent scene. */
  openFile(input: {
    readonly path: string
    readonly label: string
    readonly format: MolFormat
    readonly bytes: Uint8Array
    readonly fileResourceUri?: string
    readonly commands: readonly MolCommand[]
  }): SceneSnapshot {
    return this.open(input, 'file', false)
  }

  private open(input: {
    readonly path: string
    readonly label: string
    readonly format: MolFormat
    readonly bytes: Uint8Array
    readonly fileResourceUri?: string
    readonly commands: readonly MolCommand[]
  }, source: SceneSource, makeActive: boolean): SceneSnapshot {
    const summary = safeSummary(input.bytes, input.format)
    const record: SceneRecord = {
      sceneId: randomUUID(),
      path: input.path,
      label: input.label,
      format: input.format,
      source,
      bytes: input.bytes,
      ...(input.fileResourceUri === undefined ? {} : { fileResourceUri: input.fileResourceUri }),
      commands: input.commands,
      revision: 1,
      ...(summary === undefined ? {} : { summary }),
    }
    if (makeActive) this.agentScene = record
    this.byId.set(record.sceneId, record)
    this.evictOldScenes()
    this.notify()
    return snapshotOf(record)
  }

  /** Append one command to the agent scene. Returns null when nothing is open. */
  pushAgent(command: MolCommand): SceneSnapshot | null {
    const current = this.agentScene
    if (current === null) return null
    const record: SceneRecord = {
      ...current,
      commands: [...current.commands, command],
      revision: current.revision + 1,
    }
    this.agentScene = record
    this.byId.set(record.sceneId, record)
    this.notify()
    return snapshotOf(record)
  }

  /** Current agent scene snapshot, if any. */
  snapshotAgent(): SceneSnapshot | null {
    return this.agentScene === null ? null : snapshotOf(this.agentScene)
  }

  /** Snapshot of a specific scene, including independent file-viewer scenes. */
  snapshotById(sceneId: string): SceneSnapshot | null {
    const record = this.byId.get(sceneId)
    return record === undefined ? null : snapshotOf(record)
  }

  /** Full record for a scene id, used by the structure resource. */
  record(sceneId: string): SceneRecord | undefined {
    return this.byId.get(sceneId)
  }

  /** Last time a scene was created or changed. */
  get revision(): number {
    return this.agentScene?.revision ?? 0
  }

  get sceneId(): string | null {
    return this.agentScene?.sceneId ?? null
  }

  /** Wait until the store changes, the timeout expires, or the caller aborts. */
  waitForChange(timeoutMs: number, signal: AbortSignal): Promise<'changed' | 'timeout' | 'aborted'> {
    if (signal.aborted) return Promise.resolve('aborted')
    return new Promise(resolve => {
      const settle = (result: 'changed' | 'timeout' | 'aborted'): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        this.listeners.delete(notify)
        resolve(result)
      }
      const notify = (): void => { settle('changed') }
      const abort = (): void => { settle('aborted') }
      const timer = setTimeout(() => { settle('timeout') }, timeoutMs)
      this.listeners.add(notify)
      signal.addEventListener('abort', abort, { once: true })
    })
  }

  /** Wake long-pollers without changing the scene (used for capture requests). */
  wake(): void {
    this.notify()
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }

  private evictOldScenes(): void {
    while (this.byId.size > MAX_SCENES) {
      const oldest = this.byId.keys().next()
      if (oldest.done === true) return
      if (oldest.value === this.agentScene?.sceneId) return
      this.byId.delete(oldest.value)
    }
  }
}

function snapshotOf(record: SceneRecord): SceneSnapshot {
  return {
    sceneId: record.sceneId,
    revision: record.revision,
    label: record.label,
    format: record.format,
    source: record.source,
    ...(record.fileResourceUri === undefined ? {} : { fileResourceUri: record.fileResourceUri }),
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
