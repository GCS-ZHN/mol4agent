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
import { createComponent, createEffect } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import type { MolViewer } from '@gcszhn/mol4agent-core'
import { bytesToBase64 } from '../base64.ts'
import { Mol4Agent } from '../rpc.ts'
import { captureDecision, mergeScenes, missingPaths, routeSceneEvent, selectScene } from './routing.ts'
import { StructureGroup, StructurePool } from './structure-group.ts'
import { type FetchedScene, type SceneInfo } from './viewer.tsx'

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
    /** Scenes per session: sessionID -> path -> scene. */
    const [scenes, setScenes] = createStore<Record<string, Record<string, SceneInfo>>>({})
    /** Active tab path per session, for the menu item. */
    const [active, setActive] = createStore<Record<string, string>>({})
    /** Sessions whose scene list has loaded; before that, stored tabs stay listed. */
    const [loadedSessions, setLoadedSessions] = createStore<Record<string, boolean>>({})
    /** Tab objects per session and path, reused so strip updates do not rebuild triggers. */
    const tabs = new Map<string, { readonly id: string; readonly title: string; readonly group: string; readonly missing: boolean }>()

    /** Live viewers keyed by sceneId, for capture delivery. */
    const viewers = new Map<string, MolViewer>()
    /** When each scene's viewer was registered, so a fresh mount can settle. */
    const registeredAt = new Map<string, number>()
    /** Structures opened while their session was not routed, keyed by session. */
    const pendingOpen = new Map<string, string>()
    /** Captures already being delivered, so an event + claim cannot double-run. */
    const inFlight = new Set<string>()

    const trackViewer = (sceneId: string, viewer: MolViewer | undefined): void => {
      if (viewer !== undefined) {
        if (!viewers.has(sceneId)) registeredAt.set(sceneId, Date.now())
        viewers.set(sceneId, viewer)
      } else {
        viewers.delete(sceneId)
        registeredAt.delete(sceneId)
      }
    }

    /** Viewers outlive a panel render and the session switch that unmounts it. */
    const pool = new StructurePool({
      scene: (sessionID: string, path: string) => selectScene(scenes, sessionID, path),
      fetchScene: async (sceneId: string, sessionID: string) =>
        (await rpc.fetchScene({ sceneId, sessionID })) as unknown as FetchedScene,
      theme: () => ctx.appearance.mode(),
      onViewer: trackViewer,
    })

    /** `load()` starts a 250 ms camera-focus animation; a capture before it ends
     *  can render only the background, so let a freshly registered viewer settle. */
    const FIRST_FRAME_SETTLE_MS = 400

    let refreshToken = 0
    let lastSessionID: string | undefined
    let disposed = false

    const currentSessionID = (): string => ctx.sessions.current()?.id ?? ''

    const labelOf = (path: string): string => {
      const normalized = path.replaceAll('\\', '/')
      const name = normalized.slice(normalized.lastIndexOf('/') + 1)
      return name === '' ? path : name
    }

    const tabFor = (
      sessionID: string,
      path: string,
      title: string,
      missing: boolean,
    ): { id: string; title: string; group: string; missing: boolean } => {
      const key = `${sessionID}\n${path}`
      const cached = tabs.get(key)
      if (cached !== undefined && cached.title === title && cached.missing === missing) return cached
      const next = { id: path, title, group: 'structure', missing }
      tabs.set(key, next)
      return next
    }

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
        if (disposed || token !== refreshToken) return
        // `reconcile` removes paths the session no longer has; a plain
        // set would leave stale keys behind. Keep other sessions' maps so a
        // switch back does not rebuild their viewers.
        setScenes(sessionID, reconcile(mergeScenes(list.scenes)))
        setActive(sessionID, list.active)
        setLoadedSessions(sessionID, true)
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

    /** A hidden/detached slot must be laid out and resized before capturing. */
    const waitForViewerLayout = async (viewer: MolViewer, ms: number): Promise<boolean> => {
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        const host = viewer.diagnostics().host
        if (host.clientWidth >= 32 && host.clientHeight >= 32) {
          viewer.resize()
          // Let the resize draw land before the screenshot helper renders.
          await new Promise<void>(resolve => {
            if (typeof requestAnimationFrame === 'function') {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
            } else {
              setTimeout(resolve, 32)
            }
          })
          return true
        }
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      return false
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
      // A session switch during the wait must leave the capture pending for the
      // next claim, not fail it. Only fail when the session still matches.
      const decision = captureDecision(capture.sessionID, currentSessionID(), viewer !== undefined)
      if (decision === 'leave-pending') return
      if (decision === 'fail') {
        await rpc.failCapture({
          captureId: capture.captureId,
          message:
            'the structure viewer tab is not visible; open the molecular viewer from the side panel and retry mol_capture',
        })
        return
      }
      if (viewer === undefined) return
      if (!(await waitForViewerLayout(viewer, 5000))) {
        if (capture.sessionID !== currentSessionID()) return
        await rpc.failCapture({
          captureId: capture.captureId,
          message:
            'the structure viewer tab has no layout size; open the side panel and retry mol_capture',
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
      const route = routeSceneEvent(currentSessionID(), data)
      if (route.action === 'ignore') return
      if (route.action === 'queue') {
        // The agent opened a structure while another session is routed; open it
        // when the user switches there instead of dropping the event.
        pendingOpen.set(route.sessionID, route.path)
        return
      }
      const session = ctx.sessions.current()
      void refresh(route.sessionID).then(() => {
        if (disposed) return
        if (route.sessionID !== currentSessionID()) {
          // Routed away while refreshing: keep the open for the next visit.
          if (route.path !== undefined) pendingOpen.set(route.sessionID, route.path)
          return
        }
        // Always reopen on `open` (also when the active path is unchanged, e.g.
        // the user closed the tab and `mol_open` reopened the same file).
        if (route.path !== undefined) openTab(session, route.path, true)
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
        // Keep listing stored tabs even before the scene list arrives: an empty
        // list would make the host drop tabs and rebuild their viewers.
        const byPath = scenes[input.session.id] ?? {}
        const loaded = loadedSessions[input.session.id] === true
        const keep = new Set(input.open)
        const prefix = `${input.session.id}\n`
        for (const key of tabs.keys()) {
          if (key.startsWith(prefix) && !keep.has(key.slice(prefix.length))) tabs.delete(key)
        }
        // Once the server's list is known, a stored path without a scene is
        // stale (LRU eviction or a server restart). Mark it and release its
        // viewer instead of showing old pixels that no tool can operate.
        const stale = new Set(missingPaths(input.open, Object.keys(byPath), loaded))
        for (const path of stale) pool.dispose(input.session.key, path)
        return input.open.map(id => tabFor(input.session.id, id, byPath[id]?.label ?? labelOf(id), stale.has(id)))
      },
      render: (props) => createComponent(StructureGroup, {
        tab: () => props.tab.id,
        session: () => props.session,
        pool,
      }),
      close: (input) => {
        pool.dispose(input.session.key, input.tab.id)
        tabs.delete(`${input.session.id}\n${input.tab.id}`)
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
        // Only use the link's own workspace. Falling back to the routed
        // session's directory would resolve another session's relative path in
        // the wrong workspace.
        const directory = link.session === undefined
          ? ctx.sessions.current()?.directory
          : link.session.location?.directory
        if (link.session !== undefined && directory === undefined) {
          ctx.toast.show({
            variant: 'error',
            title: 'Could not open structure',
            description: 'The session workspace is not available yet; try again in a moment.',
          })
          return
        }
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
        const path = active[session.id] ?? ''
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
      pool.disposeAll()
      for (const viewer of viewers.values()) viewer.dispose()
      viewers.clear()
      registeredAt.clear()
      pendingOpen.clear()
      inFlight.clear()
      tabs.clear()
    }
  },
})
