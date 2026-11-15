/**
 * One render for all structure tabs (a `PanelTab.group`): viewers stay mounted
 * while their tab is listed, so switching tabs keeps camera/style/selection
 * state instead of reloading the structure. A tab's viewer is disposed only
 * when the host closes that tab (`Panel.close`) or the whole panel unmounts.
 *
 * Built without JSX like the rest of the GUI; each slot is a Solid root that
 * mounts one `StructureViewer` into its own absolutely positioned host, and the
 * active slot is the only one displayed.
 *
 * @module @gcszhn/mol4agent-opencode/structure-group
 */
import { createComponent, createEffect, createRoot, onCleanup, type JSX } from 'solid-js'
import type { MountedSession } from '@opencode/plugin/gui'
import type { MolViewer } from '@gcszhn/mol4agent-core'
import { StructureViewer, type FetchedScene, type SceneInfo } from './viewer.tsx'

/** Lets `Panel.close` reach the group's per-tab viewer disposers. */
export interface StructureGroupRegistry {
  dispose?(sessionKey: string, path: string): void
}

interface Slot {
  readonly host: HTMLDivElement
  readonly dispose: () => void
}

export function StructureGroup(props: {
  /** Active tab id (the structure path). */
  readonly tab: () => string
  /** Routed session; a new object when another session is routed. */
  readonly session: () => MountedSession
  readonly scene: (sessionID: string, path: string) => SceneInfo | undefined
  readonly fetchScene: (sceneId: string, sessionID: string) => Promise<FetchedScene>
  readonly theme: () => 'light' | 'dark'
  readonly onViewer: (sceneId: string, viewer: MolViewer | undefined) => void
  readonly registry: StructureGroupRegistry
}): JSX.Element {
  const root = document.createElement('div')
  root.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;'
  const slots = new Map<string, Slot>()

  const keyOf = (sessionKey: string, path: string): string => `${sessionKey}\n${path}`

  const ensure = (): void => {
    const session = props.session()
    const path = props.tab()
    if (path === '') return
    const key = keyOf(session.key, path)
    if (!slots.has(key)) {
      const host = document.createElement('div')
      host.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;'
      root.appendChild(host)
      const sessionID = session.id
      const dispose = createRoot((disposeRoot) => {
        const viewer = createComponent(StructureViewer, {
          scene: () => props.scene(sessionID, path),
          fetchScene: (sceneId: string) => props.fetchScene(sceneId, sessionID),
          theme: props.theme,
          onViewer: props.onViewer,
        })
        if (viewer instanceof Node) host.appendChild(viewer)
        return disposeRoot
      })
      slots.set(key, { host, dispose })
    }
    for (const [candidate, slot] of slots) slot.host.style.display = candidate === key ? 'block' : 'none'
  }

  const disposeSlot = (sessionKey: string, path: string): void => {
    const key = keyOf(sessionKey, path)
    const slot = slots.get(key)
    if (slot === undefined) return
    slots.delete(key)
    slot.dispose()
    slot.host.remove()
  }

  props.registry.dispose = disposeSlot

  createEffect(ensure)
  onCleanup(() => {
    if (props.registry.dispose === disposeSlot) props.registry.dispose = undefined
    for (const slot of slots.values()) {
      slot.dispose()
      slot.host.remove()
    }
    slots.clear()
  })

  return root
}
