/**
 * Viewer slots for structure tabs, kept across panel-render remounts.
 *
 * A Mol* viewer is a WebGL/DOM object, so preserving its camera pose, style,
 * color, selection, and measurements means preserving the viewer instance, not
 * replaying the scene log. The pool lives in the plugin setup closure (the
 * session/panel lifetime), creates one viewer per `session key + path`, and:
 *
 * - attaches the slots to whichever `Panel.render` is mounted;
 * - detaches them to a hidden, in-DOM container when that render unmounts (a
 *   session switch must not destroy viewers);
 * - disposes a slot when its structure tab closes (`Panel.close`) or when the
 *   plugin/window unloads. `sessions.list()` is not a reliable close signal:
 *   a route change can drop the previous session while its tab is still open,
 *   so pruning on it would destroy viewers on every switch.
 *
 * @module @gcszhn/mol4agent-opencode/structure-group
 */
import { createComponent, createEffect, createRoot, onCleanup, type JSX } from 'solid-js'
import type { MountedSession } from '@opencode/plugin/gui'
import type { MolViewer } from '@gcszhn/mol4agent-core'
import { StructureViewer, type FetchedScene, type SceneInfo } from './viewer.tsx'

interface Slot {
  readonly host: HTMLDivElement
  readonly dispose: () => void
}

const keyOf = (sessionKey: string, path: string): string => `${sessionKey}\n${path}`

export interface StructurePoolOptions {
  readonly scene: (sessionID: string, path: string) => SceneInfo | undefined
  readonly fetchScene: (sceneId: string, sessionID: string) => Promise<FetchedScene>
  readonly theme: () => 'light' | 'dark'
  readonly onViewer: (sceneId: string, viewer: MolViewer | undefined) => void
}

export class StructurePool {
  private readonly slots = new Map<string, Slot>()
  private readonly detached: HTMLDivElement
  private attachedRoot: HTMLDivElement | undefined
  private disposed = false

  constructor(private readonly options: StructurePoolOptions) {
    // Keep detached viewers in the document so their WebGL context and layout
    // observation survive while no panel render is mounted.
    this.detached = document.createElement('div')
    this.detached.style.cssText =
      'position:fixed;left:-100000px;top:0;width:1px;height:1px;overflow:hidden;pointer-events:none;'
    document.body.appendChild(this.detached)
  }

  /** Mount the pool's slots into the panel render that just mounted. */
  attach(root: HTMLDivElement): void {
    if (this.disposed) return
    this.attachedRoot = root
    for (const slot of this.slots.values()) {
      if (slot.host.parentElement !== root) root.appendChild(slot.host)
    }
  }

  /** Move the slots out of a render that is unmounting, without disposing them. */
  detach(root: HTMLDivElement): void {
    if (this.attachedRoot === root) this.attachedRoot = undefined
    for (const slot of this.slots.values()) {
      if (slot.host.parentElement === root) this.detached.appendChild(slot.host)
    }
  }

  /** Create/reuse the slot for one structure and show only it. */
  show(sessionKey: string, sessionID: string, path: string): void {
    if (this.disposed || path === '') return
    const key = keyOf(sessionKey, path)
    if (!this.slots.has(key)) {
      const host = document.createElement('div')
      host.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;'
      const dispose = createRoot((disposeRoot) => {
        const viewer = createComponent(StructureViewer, {
          scene: () => this.options.scene(sessionID, path),
          fetchScene: (sceneId: string) => this.options.fetchScene(sceneId, sessionID),
          theme: this.options.theme,
          onViewer: this.options.onViewer,
        })
        if (viewer instanceof Node) host.appendChild(viewer)
        return disposeRoot
      })
      this.slots.set(key, { host, dispose })
      ;(this.attachedRoot ?? this.detached).appendChild(host)
    }
    for (const [candidate, slot] of this.slots) slot.host.style.display = candidate === key ? 'block' : 'none'
  }

  /** A structure tab closed: destroy its viewer. */
  dispose(sessionKey: string, path: string): void {
    this.disposeKey(keyOf(sessionKey, path))
  }

  /** Plugin teardown: destroy every viewer and the hidden container. */
  disposeAll(): void {
    if (this.disposed) return
    for (const key of [...this.slots.keys()]) this.disposeKey(key)
    this.disposed = true
    this.detached.remove()
  }

  private disposeKey(key: string): void {
    const slot = this.slots.get(key)
    if (slot === undefined) return
    this.slots.delete(key)
    slot.dispose()
    slot.host.remove()
  }
}

/** The one `Panel.render` shared by all structure tabs (see `PanelTab.group`). */
export function StructureGroup(props: {
  /** Active tab id (the structure path). */
  readonly tab: () => string
  /** Routed session; a new object when another session is routed. */
  readonly session: () => MountedSession
  readonly pool: StructurePool
}): JSX.Element {
  const root = document.createElement('div')
  root.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;'
  props.pool.attach(root)
  createEffect(() => {
    const session = props.session()
    props.pool.show(session.key, session.id, props.tab())
  })
  onCleanup(() => props.pool.detach(root))
  return root
}
