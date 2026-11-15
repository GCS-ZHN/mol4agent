/**
 * OpenCode 2 GUI part for mol4agent: a side panel with one Mol* viewer tab per
 * open structure, the launcher, a pick-file command, and a `LinkHandler`
 * (Ctrl+P file search, the `/open` command).
 *
 * There is deliberately no `/mol_open` slash command: its name collides with
 * the agent tool `mol_open`, and Ctrl+P plus the pick-file command cover the
 * human paths.
 *
 * Scenes follow the routed session: a session switch resets the local scene
 * list, refreshes it from the server, and claims captures that were requested
 * while another session was routed.
 *
 * Built without JSX (esbuild + `createComponent` + imperative DOM): Solid 1.9
 * has no standalone JSX runtime, and the GUI must keep core's chunk lazy so
 * Mol*'s Markdown dependency never runs in the Electron main process.
 *
 * @module @gcszhn/mol4agent-opencode/gui
 */
import { Plugin, Panel, Command, MenuItem, LinkHandler, type SessionRef } from '@opencode/plugin/gui'
import { createComponent, createEffect, createSignal } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import type { MolViewer } from '@gcszhn/mol4agent-core'
import { bytesToBase64 } from '../base64.ts'
import { Mol4Agent } from '../rpc.ts'
import { StructureViewer, type FetchedScene, type SceneInfo } from './viewer.tsx'

const EXTENSIONS = ['pdb', 'ent', 'pdbqt', 'pqr', 'cif', 'mmcif', 'mcif', 'bcif', 'mol', 'sdf', 'sd', 'mol2', 'xyz', 'gro', 'gz']

interface SceneList {
  readonly active: string
  readonly scenes: readonly SceneInfo[]
}

interface CaptureRequest {
  readonly captureId: string
  readonly sceneId: string
  readonly path: string
  readonly width: number
  readonly height: number
  readonly transparent: boolean
}

interface CaptureEvent extends CaptureRequest {
  readonly sessionID: string
}

interface SceneEvent {
  readonly sessionID: string
  readonly path?: string
  readonly open?: boolean
}

export default Plugin.define({
  setup(ctx) {
    const rpc = ctx.client.rpc(Mol4Agent)
    const [scenes, setScenes] = createStore<Record<string, SceneInfo>>({})
    const [active, setActive] = createSignal('')
    /** Session the `scenes` store belongs to; guards against stale routing. */
    const [loadedSessionID, setLoadedSessionID] = createSignal('')

    /** Live viewers keyed by sceneId, for capture delivery. */
    const viewers = new Map<string, MolViewer>()
    /** When each scene's viewer was registered, so a fresh mount can settle. */
    const registeredAt = new Map<string, number>()
    /** Structures opened while their session was not routed, keyed by session. */
    const pendingOpen = new Map<string, string>()
    /** Captures already being delivered, so an event + claim cannot double-run. */
    const inFlight = new Set<string>()

    /** `load()` starts a 250 ms camera-focus animation; a capture before it ends
     *  can render only the background, so let a freshly registered viewer settle. */
    const FIRST_FRAME_SETTLE_MS = 400

    let refreshToken = 0
    let lastSessionID: string | undefined
    let disposed = false

    const currentSessionID = (): string => ctx.sessions.current()?.id ?? ''

    const openTab = (session: SessionRef | undefined, path: string, background: boolean): void => {
      if (session === undefined || path === '') return
      ctx.layout.open(`${ctx.id}:${path}`, session, { tab: 'select', ...(background ? { background: true } : {}) })
    }

    /** Load one session's scenes; stale responses must not overwrite a new route. */
    const refresh = async (sessionID: string): Promise<void> => {
      if (sessionID === '') return
      const token = ++refreshToken
      try {
        const list = (await rpc.listScenes({ sessionID })) as unknown as SceneList
        if (disposed || token !== refreshToken || sessionID !== currentSessionID()) return
        const next: Record<string, SceneInfo> = {}
        for (const scene of list.scenes) next[scene.path] = scene
        // `reconcile` removes paths the session no longer has; a plain
        // `setScenes(next)` would leave stale keys behind.
        setScenes(reconcile(next))
        setActive(list.active)
        setLoadedSessionID(sessionID)
      } catch (reason) {
        if (token === refreshToken) console.warn('[mol4agent] could not list scenes', reason)
      }
    }

    const waitForViewer = async (sceneId: string, ms: number): Promise<MolViewer | undefined> => {
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        const viewer = viewers.get(sceneId)
        if (viewer !== undefined) return viewer
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      return undefined
    }

    const deliver = async (capture: CaptureEvent): Promise<void> => {
      if (inFlight.has(capture.captureId)) return
      inFlight.add(capture.captureId)
      try {
        await deliverOnce(capture)
      } finally {
        inFlight.delete(capture.captureId)
      }
    }

    const deliverOnce = async (capture: CaptureEvent): Promise<void> => {
      // Another session's capture stays pending; the session effect claims it
      // after the user routes back. Never open it in the wrong session.
      if (disposed || capture.sessionID !== currentSessionID()) return
      const session = ctx.sessions.current()
      if (session?.id !== capture.sessionID) return
      // Ensure the scene store has this scene (the panel `list` filters through
      // it), then reveal the target tab so its viewer mounts.
      await refresh(capture.sessionID)
      if (disposed || capture.sessionID !== currentSessionID()) return
      openTab(session, capture.path, false)
      const viewer = await waitForViewer(capture.sceneId, 15_000)
      if (disposed) return
      if (viewer === undefined) {
        await rpc.failCapture({
          captureId: capture.captureId,
          message:
            'the structure viewer tab is not visible; open the molecular viewer from the side panel and retry mol_capture',
        })
        return
      }
      if (capture.sessionID !== currentSessionID()) return
      const since = registeredAt.get(capture.sceneId)
      const settle = since === undefined ? 0 : FIRST_FRAME_SETTLE_MS - (Date.now() - since)
      if (settle > 0) await new Promise(resolve => setTimeout(resolve, settle))
      try {
        const png = await viewer.capture({ width: capture.width, height: capture.height, transparent: capture.transparent })
        await rpc.deliverCapture({ captureId: capture.captureId, data: bytesToBase64(png), width: capture.width, height: capture.height })
      } catch (reason) {
        if (disposed || capture.sessionID !== currentSessionID()) return
        await rpc.failCapture({ captureId: capture.captureId, message: reason instanceof Error ? reason.message : String(reason) })
      }
    }

    /** RPC events are live-only, so claim captures queued before this route. */
    const claimPending = async (sessionID: string, session: SessionRef | undefined): Promise<void> => {
      if (sessionID === '' || session === undefined) return
      try {
        const pending = (await rpc.pendingCaptures({ sessionID })) as unknown as {
          captures: readonly CaptureRequest[]
        }
        if (disposed || sessionID !== currentSessionID()) return
        for (const capture of pending.captures) void deliver({ ...capture, sessionID })
      } catch {
        // Capture claim is best-effort.
      }
    }

    createEffect(() => {
      const session = ctx.sessions.current()
      const sessionID = session?.id ?? ''
      if (sessionID === lastSessionID) return
      lastSessionID = sessionID
      setLoadedSessionID('')
      setActive('')
      setScenes(reconcile({}))
      if (session === undefined || sessionID === '') return
      void (async () => {
        await refresh(sessionID)
        if (disposed || sessionID !== currentSessionID()) return
        const path = pendingOpen.get(sessionID)
        if (path !== undefined) {
          pendingOpen.delete(sessionID)
          openTab(session, path, true)
        }
        await claimPending(sessionID, session)
      })()
    })

    const offScene = rpc.events.on('scene', (event) => {
      const data = (event as unknown as { data: SceneEvent }).data
      const sessionID = data?.sessionID ?? currentSessionID()
      if (sessionID !== currentSessionID()) {
        // The agent opened a structure while another session is routed; open it
        // when the user switches there instead of dropping the event.
        if (data?.open === true && data.path !== undefined) pendingOpen.set(sessionID, data.path)
        return
      }
      const session = ctx.sessions.current()
      void refresh(sessionID).then(() => {
        if (disposed || sessionID !== currentSessionID()) return
        // Always reopen on `open` (also when the active path is unchanged, e.g.
        // the user closed the tab and `mol_open` reopened the same file).
        if (data?.open === true && data.path !== undefined) openTab(session, data.path, true)
      })
    })
    const offCapture = rpc.events.on('capture', (event) => {
      const data = (event as unknown as { data: CaptureEvent }).data
      if (data?.sessionID !== undefined && data.sessionID !== currentSessionID()) return
      void deliver(data)
    })

    ctx.add(Panel, {
      id: 'structure',
      region: 'side',
      width: 640,
      list: (input) => {
        // The panel lists the routed session's strip; only expose scenes that
        // belong to it, even if a refresh for another session is in flight.
        if (loadedSessionID() !== input.session.id) return []
        return input.open
          .map(id => scenes[id])
          .filter((scene): scene is SceneInfo => scene !== undefined)
          .map(scene => ({ id: scene.path, title: scene.label }))
      },
      render: (props) => {
        const path = props.tab.id
        const sessionID = (): string => props.session.id
        return createComponent(StructureViewer, {
          scene: (): SceneInfo | undefined => (loadedSessionID() === sessionID() ? scenes[path] : undefined),
          fetchScene: async (sceneId: string) =>
            (await rpc.fetchScene({ sceneId, sessionID: sessionID() })) as unknown as FetchedScene,
          theme: () => ctx.appearance.mode(),
          onViewer: (sceneId: string, viewer: MolViewer | undefined) => {
            if (viewer !== undefined) {
              if (!viewers.has(sceneId)) registeredAt.set(sceneId, Date.now())
              viewers.set(sceneId, viewer)
            } else {
              viewers.delete(sceneId)
              registeredAt.delete(sceneId)
            }
          },
        })
      },
    })

    // Intercept clicks on a molecular file/link and open it in the Mol* panel.
    // Ctrl+P file search (the `/open` command) goes through this; the built-in
    // file tree does not.
    // `match` sees the absolute path but `open` may get only the basename, so
    // cache the full path from `match` and reuse it in `open`.
    const MOLECULAR_HREF = /\.(pdb|ent|pdbqt|pqr|cif|mmcif|mcif|bcif|mol|sdf|sd|mol2|xyz|gro)(\.gz)?$/iu
    const isWindowsDrive = (href: string): boolean => /^[a-z]:[\\/]/iu.test(href)
    const hrefToPath = (href: string): string => {
      if (!href.startsWith('file://')) return href
      let path: string
      try {
        path = decodeURIComponent(href.slice('file://'.length))
      } catch {
        path = href.slice('file://'.length)
      }
      // `file:///C:/...` decodes to `/C:/...`; drop the URL-only slash.
      return /^\/[a-z]:[\\/]/iu.test(path) ? path.slice(1) : path
    }
    const isRemote = (href: string): boolean =>
      !href.startsWith('file://') && !isWindowsDrive(href) && /^[a-z][a-z0-9+.-]*:/iu.test(href)
    const isAbsolutePath = (href: string): boolean =>
      href.startsWith('/') || href.startsWith('\\') || isWindowsDrive(href)
    const isPath = (href: string): boolean => /[\\/]/u.test(href)
    const basenameOf = (href: string): string => {
      const path = hrefToPath(href).replaceAll('\\', '/')
      return path.slice(path.lastIndexOf('/') + 1)
    }
    const joinPath = (left: string, right: string): string => {
      if (right === '' || right === '.') return left
      return `${left.replace(/[\\/]+$/u, '')}/${right.replace(/^[\\/]+/u, '')}`
    }
    const linkedPaths = new Map<string, string>()
    ctx.add(LinkHandler, {
      priority: 10,
      match: (link) => {
        if (isRemote(link.href)) return false
        // Only exact workspace files or path-like text: a bare `foo.pdb` in
        // prose must not become a link.
        if (link.exact !== true && !isPath(link.href)) return false
        const hit = MOLECULAR_HREF.test(link.href)
        if (hit && isPath(link.href)) linkedPaths.set(basenameOf(link.href), hrefToPath(link.href))
        return hit
      },
      open: (link) => {
        if (isRemote(link.href)) return
        const href = hrefToPath(link.href)
        const resolved = isPath(href) ? href : (linkedPaths.get(basenameOf(href)) ?? href)
        const session = link.session ?? ctx.sessions.current()
        const sessionID = link.session?.id ?? currentSessionID()
        const directory = link.session?.location?.directory ?? ctx.sessions.current()?.directory
        const baseDirectory = link.base === undefined
          ? directory
          : isAbsolutePath(link.base)
            ? link.base
            : directory === undefined
              ? undefined
              : joinPath(directory, link.base)
        const cwd = isAbsolutePath(resolved) ? directory : baseDirectory
        void rpc.openPath({ path: resolved, cwd: cwd === '' ? undefined : cwd, sessionID }).then((raw) => {
          const result = raw as { ok: boolean; path?: string; tab?: string; error?: string }
          if (!result.ok) {
            ctx.toast.show({ variant: 'error', title: 'Could not open structure', description: result.error })
            return
          }
          if (result.tab !== undefined) openTab(session, result.tab, link.background === true)
        })
      },
      exists: (link) => {
        if (isRemote(link.href)) return false
        // The GUI has no filesystem, so only claim links the host marked exact
        // or that are visibly paths.
        return link.exact === true || isPath(link.href)
      },
    })

    ctx.add(MenuItem, () => ({
      menu: 'session.panel' as const,
      id: 'structure',
      title: 'Molecular viewer',
      icon: 'flask' as const,
      run: () => {
        const session = ctx.sessions.current()
        if (!session) return
        const path = loadedSessionID() === session.id ? active() : ''
        if (path !== '') ctx.layout.open(`${ctx.id}:${path}`, session)
        else ctx.toast.show({ title: 'No structure open', description: 'Use mol_open or the "Open molecular structure" command.' })
      },
    }))

    ctx.add(Command, () => ({
      id: 'open',
      title: 'Open molecular structure',
      keywords: 'mol pdb cif structure viewer molecule',
      section: 'session' as const,
      run: async () => {
        if (!ctx.desktop) return
        const session = ctx.sessions.current()
        const picked = await ctx.desktop.pick({ extensions: EXTENSIONS, multiple: false })
        const path = picked?.[0]
        if (!path) return
        const result = (await rpc.openPath({ path, cwd: session?.directory, sessionID: currentSessionID() })) as unknown as {
          ok: boolean
          tab?: string
          error?: string
        }
        if (!result.ok) {
          ctx.toast.show({ variant: 'error', title: 'Could not open structure', description: result.error })
          return
        }
        if (result.tab !== undefined) openTab(session, result.tab, false)
      },
    }))

    return () => {
      disposed = true
      offScene()
      offCapture()
      for (const viewer of viewers.values()) viewer.dispose()
      viewers.clear()
      registeredAt.clear()
      pendingOpen.clear()
      inFlight.clear()
    }
  },
})
