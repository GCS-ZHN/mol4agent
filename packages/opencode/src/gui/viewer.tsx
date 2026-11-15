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
import type { MolCommand, MolFormat } from '@gcszhn/mol4agent-core/protocol'
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
}

/** Bytes + metadata returned by the `fetchScene` RPC method. */
export interface FetchedScene {
  readonly sceneId: string
  readonly format: string
  readonly label: string
  readonly binary: boolean
  readonly data: string
}

export function StructureViewer(props: {
  readonly scene: () => SceneInfo | undefined
  readonly fetchScene: (sceneId: string) => Promise<FetchedScene>
  readonly theme: () => 'light' | 'dark'
  readonly onViewer: (sceneId: string, viewer: MolViewer | undefined) => void
}): JSX.Element {
  let viewer: MolViewer | undefined
  let boundSceneId: string | undefined
  let registeredSceneId: string | undefined
  let applied = 0
  let disposed = false
  let queue: Promise<void> = Promise.resolve()

  const host = document.createElement('div')
  host.style.cssText = 'width:100%;height:100%;min-height:320px;position:relative;overflow:hidden;'

  const register = (sceneId: string): void => {
    if (registeredSceneId !== undefined && registeredSceneId !== sceneId) {
      props.onViewer(registeredSceneId, undefined)
    }
    registeredSceneId = sceneId
    props.onViewer(sceneId, viewer as MolViewer)
  }

  const sync = (scene: SceneInfo): void => {
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
          const fetched = await props.fetchScene(scene.sceneId)
          if (disposed) return
          await current.load({
            data: base64ToBytes(fetched.data),
            format: fetched.format as MolFormat,
            label: fetched.label,
            binary: fetched.binary,
          })
          boundSceneId = scene.sceneId
          applied = 0
        }
        if (disposed) return
        register(scene.sceneId)
        if (scene.commands.length < applied) applied = 0
        const pending = scene.commands.slice(applied)
        if (pending.length > 0) {
          const results = await current.apply(pending)
          for (const result of results) {
            if (!result.ok) console.warn('[mol4agent]', result.message)
          }
          applied = scene.commands.length
        }
      })
      .catch(reason => console.warn('[mol4agent]', reason))
  }

  createEffect(() => {
    const scene = props.scene()
    if (scene !== undefined) sync(scene)
  })

  createEffect(() => {
    viewer?.setTheme(props.theme())
  })

  onCleanup(() => {
    disposed = true
    if (registeredSceneId !== undefined) props.onViewer(registeredSceneId, undefined)
    viewer?.dispose()
    viewer = undefined
  })

  return host
}
