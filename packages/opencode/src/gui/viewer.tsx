/**
 * The Solid component that mounts core's official Mol* viewer into a panel tab.
 *
 * Built without JSX and with a single lazy `loadCore()` call: the GUI bundle is
 * compiled by esbuild (which keeps core's chunk lazy), so Solid JSX cannot be
 * compiled here (Solid 1.9 has no standalone `jsx` runtime), and inlining core
 * eagerly would run Mol*'s Markdown dependency in the Electron main process.
 *
 * @module @gcszhn/mol4agent-opencode/viewer
 */
import { createEffect, onCleanup, type JSX } from 'solid-js'
import type { MolViewer } from '@gcszhn/mol4agent-core'
import type { CommandResult, MolCommand, MolFormat } from '@gcszhn/mol4agent-core/protocol'
import { base64ToBytes } from '../base64.ts'
import { loadCore } from './core-loader.ts'

/** Lightweight scene description, matching the RPC `listScenes` output item. */
export interface SceneInfo {
  readonly sceneId: string
  readonly path: string
  readonly label: string
  readonly format: string
  readonly binary: boolean
  readonly revision: number
  readonly commands: readonly MolCommand[]
  readonly structures: readonly SceneStructureInfo[]
}

/** Metadata for one structure in a scene. */
export interface SceneStructureInfo {
  readonly id: string
  readonly path: string
  readonly label: string
  readonly format: string
  readonly binary: boolean
}

/** Bytes + metadata returned by the `fetchScene` RPC method. */
export interface FetchedScene {
  readonly sceneId: string
  readonly structureId?: string
  readonly format: string
  readonly label: string
  readonly binary: boolean
  readonly data: string
}

export function StructureViewer(props: {
  readonly scene: () => SceneInfo | undefined
  readonly fetchScene: (sceneId: string) => Promise<FetchedScene>
  readonly fetchStructure: (sceneId: string, structureId: string) => Promise<FetchedScene>
  readonly theme: () => 'light' | 'dark'
  /** Report the result of an executed `align` command to the server. */
  readonly onAlignResult: (sceneId: string, commandIndex: number, result: CommandResult) => void
  /**
   * Register/unregister the live viewer. `whenIdle` waits for the command queue
   * to drain, so an inspection cannot read a half-applied style.
   */
  readonly onViewer: (sceneId: string, viewer: MolViewer | undefined, whenIdle?: () => Promise<void>) => void
}): JSX.Element {
  let viewer: MolViewer | undefined
  let boundSceneId: string | undefined
  let registeredSceneId: string | undefined
  let loadedStructures: string[] = []
  let applied = 0
  let disposed = false
  let queue: Promise<void> = Promise.resolve()

  const host = document.createElement('div')
  host.style.cssText = 'width:100%;height:100%;min-height:320px;position:relative;overflow:hidden;'

  function sync(scene: SceneInfo): void {
    queue = queue
      .then(async () => {
        if (disposed) return
        if (viewer === undefined) {
          const mod = await loadCore()
          if (disposed) return
          const created = await mod.createMolViewer({ container: host, theme: props.theme() })
          // A GUI hot-reload can dispose this component while core was loading.
          if (disposed) {
            created.dispose()
            return
          }
          viewer = created
        }
        const current = viewer
        if (current === undefined) return
        current.setTheme(props.theme())
        if (scene.sceneId !== boundSceneId) {
          const primary = scene.structures[0]
          const fetched = primary === undefined
            ? await props.fetchScene(scene.sceneId)
            : await props.fetchStructure(scene.sceneId, primary.id)
          if (disposed) return
          await current.load({
            data: base64ToBytes(fetched.data),
            format: fetched.format as MolFormat,
            label: fetched.label,
            binary: fetched.binary,
          }, primary === undefined ? undefined : { id: primary.id })
          boundSceneId = scene.sceneId
          loadedStructures = primary === undefined ? ['structure'] : [primary.id]
          applied = 0
        }
        if (disposed) return
        for (const structure of scene.structures) {
          if (loadedStructures.includes(structure.id)) continue
          const fetched = await props.fetchStructure(scene.sceneId, structure.id)
          if (disposed) return
          await current.addStructure({
            data: base64ToBytes(fetched.data),
            format: fetched.format as MolFormat,
            label: fetched.label,
            binary: fetched.binary,
          }, { id: structure.id })
          loadedStructures = [...loadedStructures, structure.id]
        }
        if (disposed) return
        if (scene.commands.length < applied) applied = 0
        const pending = scene.commands.slice(applied)
        if (pending.length > 0) {
          const start = applied
          const results = await current.apply(pending)
          for (let index = 0; index < results.length; index += 1) {
            const result = results[index]
            if (result === undefined) continue
            if (!result.ok) console.warn('[mol4agent]', result.message)
            if (pending[index]?.op === 'align') {
              props.onAlignResult(scene.sceneId, start + index, result)
            }
          }
          applied = scene.commands.length
        }
        // Register only after the initial commands are applied: `mol_capture`
        // waits for this entry, and capturing before a style/select command
        // lands would deliver the wrong picture.
        if (!disposed) register(scene.sceneId)
      })
      .catch(reason => console.warn('[mol4agent]', reason))
  }

  /**
   * Wait until the viewer has applied everything the scene store currently
   * holds. Calling `sync` here (instead of only relying on the Solid effect)
   * closes the window where a query still sees the previous style: the store
   * already has the new command, but the effect has not queued it yet.
   */
  async function whenIdle(): Promise<void> {
    const scene = props.scene()
    if (scene !== undefined) sync(scene)
    await queue
  }

  function register(sceneId: string): void {
    if (registeredSceneId !== undefined && registeredSceneId !== sceneId) {
      props.onViewer(registeredSceneId, undefined)
    }
    registeredSceneId = sceneId
    props.onViewer(sceneId, viewer as MolViewer, whenIdle)
  }

  createEffect(() => {
    const scene = props.scene()
    if (scene === undefined) return
    // `reconcile` may update these fields in place, so read what `sync`
    // depends on to keep the effect subscribed to command appends and reloads.
    void scene.sceneId
    void scene.revision
    void scene.commands.length
    sync(scene)
  })

  createEffect(() => {
    // Read the theme first: `viewer?.` short-circuits the whole call while the
    // viewer is still loading, which would skip the dependency and stop the
    // effect from re-running when the host switches light/dark.
    const theme = props.theme()
    viewer?.setTheme(theme)
  })

  onCleanup(() => {
    disposed = true
    if (registeredSceneId !== undefined) props.onViewer(registeredSceneId, undefined)
    viewer?.dispose()
    viewer = undefined
  })

  return host
}
