/**
 * The Solid component that mounts core's official Mol* viewer into a panel tab.
 *
 * It lazily imports `@gcszhn/mol4agent-core` (and with it Mol* + React) so the
 * heavy WebGL stack is only evaluated in the window that actually renders a
 * structure, never in the Electron main process that also evaluates the GUI
 * bundle's module scope.
 *
 * @module @gcszhn/mol4agent-opencode/viewer
 */
import { createEffect, onCleanup } from 'solid-js'
import type { MolViewer } from '@gcszhn/mol4agent-core'
import type { MolCommand, MolFormat } from '@gcszhn/mol4agent-core/protocol'
import { base64ToBytes } from '../base64.ts'

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
}) {
  let host: HTMLDivElement | undefined
  let viewer: MolViewer | undefined
  let boundSceneId: string | undefined
  let registeredSceneId: string | undefined
  let applied = 0
  let queue: Promise<void> = Promise.resolve()

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
        if (viewer === undefined) {
          const mod = await import('@gcszhn/mol4agent-core')
          viewer = await mod.createMolViewer({ container: host as HTMLDivElement, theme: props.theme() })
        }
        viewer.setTheme(props.theme())
        if (scene.sceneId !== boundSceneId) {
          const fetched = await props.fetchScene(scene.sceneId)
          await viewer.load({
            data: base64ToBytes(fetched.data),
            format: fetched.format as MolFormat,
            label: fetched.label,
            binary: fetched.binary,
          })
          boundSceneId = scene.sceneId
          applied = 0
        }
        register(scene.sceneId)
        if (scene.commands.length < applied) applied = 0
        const pending = scene.commands.slice(applied)
        if (pending.length > 0) {
          const results = await viewer.apply(pending)
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
    if (registeredSceneId !== undefined) props.onViewer(registeredSceneId, undefined)
    viewer?.dispose()
    viewer = undefined
  })

  return (
    <div
      ref={(el) => { host = el }}
      style={{ width: '100%', height: '100%', 'min-height': '320px', position: 'relative', overflow: 'hidden' }}
    />
  )
}
