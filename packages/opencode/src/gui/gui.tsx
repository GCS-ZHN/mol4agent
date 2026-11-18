/**
 * OpenCode 2 GUI part for mol4agent: a side panel with one Mol* viewer tab per
 * open structure, the launcher, a pick-file command, and a `LinkHandler`
 * (Ctrl+P file search, the `/open` command).
 *
 * There is deliberately no `/mol_open` slash command: its name collides with
 * the agent tool `mol_open`, and Ctrl+P plus the pick-file command cover the
 * human paths.
 *
 * The window's plugin host always loads GUI bundles from, and binds
 * `ctx.client` to, the app's **built-in** server. A session can belong to a
 * remote server, so every RPC call goes through that session's own
 * `session.server.client`; paths are forwarded raw and resolved on the server
 * that owns the session. Never send a desktop-local path or a client-computed
 * `cwd` to a remote server.
 *
 * Scenes follow the routed session: a session switch resets the local scene
 * list, refreshes it from that session's server, and claims captures that were
 * requested while another session was routed.
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
import type { InspectRequest, TmScoreRequest } from '@gcszhn/mol4agent-core/protocol'
import { bytesToBase64 } from '../base64.ts'
import { Mol4Agent } from '../rpc.ts'
import { MOLECULAR_HREF, basenameOf, hrefToPath, isPathLike, isRemoteLink } from './links.ts'
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

/** One live-state query waiting for the viewer to answer. */
interface InspectRequestEvent {
  readonly inspectId: string
  readonly sceneId: string
  readonly path: string
  readonly label: string
  readonly target?: InspectRequest['target']
  readonly detail?: InspectRequest['detail']
  readonly limit?: number
}

interface InspectEvent extends InspectRequestEvent {
  readonly sessionID: string
}

/** One TM-score query waiting for the viewer to answer. */
interface TmScoreRequestEvent {
  readonly tmScoreId: string
  readonly sceneId: string
  readonly path: string
  readonly label: string
  readonly reference: TmScoreRequest['reference']
  readonly target: TmScoreRequest['target']
}

interface TmScoreEvent extends TmScoreRequestEvent {
  readonly sessionID: string
}

/** A registered Mol* viewer plus its command-queue drain point. */
interface LiveViewer {
  readonly viewer: MolViewer
  readonly whenIdle: () => Promise<void>
}

interface SceneEvent {
  readonly sessionID: string
  readonly path?: string
  readonly open?: boolean
}

/** One event subscription per server, replaced when that server's client restarts. */
interface ServerWatch {
  readonly client: unknown
  readonly offs: readonly (() => void)[]
}

export default Plugin.define({
  setup(ctx) {
    /**
     * The RPC client of the server that owns `session`. `ctx.client` is always
     * the built-in local server, which is the wrong server for a remote session.
     */
    const rpcOf = (session: SessionRef) => {
      // Read the live server ref: a restart or re-authentication replaces its
      // client under the same server id.
      const server = ctx.servers.get(session.server.id) ?? session.server
      return server.client.rpc(Mol4Agent)
    }
    /**
     * RPC methods are location-scoped; send the session's server-side directory
     * so a multi-workspace server routes to the instance that owns the session.
     * It is the server's own path, never a client-local one.
     */
    const optionsOf = (session: SessionRef) => {
      const directory = session.location?.directory
      return directory === undefined ? undefined : { location: { directory } }
    }
    const sessionOf = (sessionID: string): SessionRef | undefined =>
      ctx.sessions.list().find(session => session.id === sessionID)

    /** Scenes per session: sessionID -> path -> scene. */
    const [scenes, setScenes] = createStore<Record<string, Record<string, SceneInfo>>>({})
    /** Active tab path per session, for the menu item. */
    const [active, setActive] = createStore<Record<string, string>>({})
    /** Sessions whose scene list has loaded; before that, stored tabs stay listed. */
    const [loadedSessions, setLoadedSessions] = createStore<Record<string, boolean>>({})
    /** Tab objects per session and path, reused so strip updates do not rebuild triggers. */
    const tabs = new Map<string, { readonly id: string; readonly title: string; readonly group: string; readonly missing: boolean }>()

    /** Live viewers keyed by sceneId, for capture and inspection delivery. */
    const viewers = new Map<string, LiveViewer>()
    /** When each scene's viewer was registered, so a fresh mount can settle. */
    const registeredAt = new Map<string, number>()
    /** Structures opened while their session was not routed, keyed by session. */
    const pendingOpen = new Map<string, string>()
    /** Captures already being delivered, so an event + claim cannot double-run. */
    const inFlight = new Set<string>()
    /** Inspections already being delivered, so an event + claim cannot double-run. */
    const inspectionsInFlight = new Set<string>()
    /** TM-score queries already being delivered. */
    const tmScoresInFlight = new Set<string>()

    const trackViewer = (
      sceneId: string,
      viewer: MolViewer | undefined,
      whenIdle?: () => Promise<void>,
    ): void => {
      if (viewer !== undefined) {
        if (!viewers.has(sceneId)) registeredAt.set(sceneId, Date.now())
        viewers.set(sceneId, { viewer, whenIdle: whenIdle ?? (async () => {}) })
      } else {
        viewers.delete(sceneId)
        registeredAt.delete(sceneId)
      }
    }

    /** Viewers outlive a panel render and the session switch that unmounts it. */
    const pool = new StructurePool({
      scene: (sessionID: string, path: string) => selectScene(scenes, sessionID, path),
      fetchScene: async (sceneId: string, sessionID: string) => {
        const session = sessionOf(sessionID)
        if (session === undefined) throw new Error(`session ${sessionID} is no longer open`)
        return (await rpcOf(session).fetchScene({ sceneId, sessionID }, optionsOf(session))) as unknown as FetchedScene
      },
      fetchStructure: async (sceneId: string, structureId: string, sessionID: string) => {
        const session = sessionOf(sessionID)
        if (session === undefined) throw new Error(`session ${sessionID} is no longer open`)
        return (await rpcOf(session).fetchStructure(
          { sceneId, structureId, sessionID },
          optionsOf(session),
        )) as unknown as FetchedScene
      },
      theme: () => ctx.appearance.mode(),
      onViewer: trackViewer,
      onAlignResult: (sessionID: string, sceneId: string, commandIndex: number, result) => {
        const session = sessionOf(sessionID)
        if (session === undefined) return
        const rpc = rpcOf(session)
        const payload = result.ok
          ? typeof result.data === 'object' && result.data !== null
            ? { sceneId, commandIndex, ok: true, result: result.data as Record<string, unknown> }
            : { sceneId, commandIndex, ok: false, message: 'the viewer returned no alignment metrics' }
          : { sceneId, commandIndex, ok: false, message: result.message }
        void rpc.deliverAlign(payload, optionsOf(session)).catch(reason => {
          console.warn('[mol4agent] could not deliver alignment metrics', reason)
        })
      },
    })

    /** `load()` starts a 250 ms camera-focus animation; a capture before it ends
     *  can render only the background, so let a freshly registered viewer settle. */
    const FIRST_FRAME_SETTLE_MS = 400

    let refreshToken = 0
    let lastSessionKey: string | undefined
    let disposed = false

    const currentSessionID = (): string => ctx.sessions.current()?.id ?? ''

    const labelOf = (path: string): string => {
      const name = basenameOf(path)
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

    /** Load one session's scenes from the server that owns it; stale responses must not overwrite a new route. */
    const refresh = async (session: SessionRef): Promise<void> => {
      const sessionID = session.id
      if (sessionID === '') return
      const token = ++refreshToken
      try {
        const list = (await rpcOf(session).listScenes({ sessionID }, optionsOf(session))) as unknown as SceneList
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

    const waitForViewer = async (sceneId: string, ms: number): Promise<LiveViewer | undefined> => {
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
      const rpc = rpcOf(session)
      // Ensure the scene store has this scene (the panel `list` filters through
      // it), then reveal the target tab so its viewer mounts.
      await refresh(session)
      if (disposed || capture.sessionID !== currentSessionID()) return
      openTab(session, capture.path, false)
      const live = await waitForViewer(capture.sceneId, 15_000)
      if (disposed) return
      // A session switch during the wait must leave the capture pending for the
      // next claim, not fail it. Only fail when the session still matches.
      const decision = captureDecision(capture.sessionID, currentSessionID(), live !== undefined)
      if (decision === 'leave-pending') return
      if (decision === 'fail') {
        await rpc.failCapture(
          {
            captureId: capture.captureId,
            message:
              'the structure viewer tab is not visible; open the molecular viewer from the side panel and retry mol_capture',
          },
          optionsOf(session),
        )
        return
      }
      if (live === undefined) return
      const viewer = live.viewer
      if (!(await waitForViewerLayout(viewer, 5000))) {
        if (capture.sessionID !== currentSessionID()) return
        await rpc.failCapture(
          {
            captureId: capture.captureId,
            message:
              'the structure viewer tab has no layout size; open the side panel and retry mol_capture',
          },
          optionsOf(session),
        )
        return
      }
      if (capture.sessionID !== currentSessionID()) return
      const since = registeredAt.get(capture.sceneId)
      const settle = since === undefined ? 0 : FIRST_FRAME_SETTLE_MS - (Date.now() - since)
      if (settle > 0) await new Promise(resolve => setTimeout(resolve, settle))
      try {
        const png = await viewer.capture({ width: capture.width, height: capture.height, transparent: capture.transparent })
        await rpc.deliverCapture(
          { captureId: capture.captureId, data: bytesToBase64(png), width: capture.width, height: capture.height },
          optionsOf(session),
        )
      } catch (reason) {
        if (disposed || capture.sessionID !== currentSessionID()) return
        await rpc.failCapture(
          { captureId: capture.captureId, message: reason instanceof Error ? reason.message : String(reason) },
          optionsOf(session),
        )
      }
    }

    const requestOf = (inspect: InspectRequestEvent): InspectRequest => ({
      ...(inspect.target === undefined ? {} : { target: inspect.target }),
      ...(inspect.detail === undefined ? {} : { detail: inspect.detail }),
      ...(inspect.limit === undefined ? {} : { limit: inspect.limit }),
    })

    const deliverInspection = async (inspect: InspectEvent): Promise<void> => {
      if (inspectionsInFlight.has(inspect.inspectId)) return
      inspectionsInFlight.add(inspect.inspectId)
      try {
        await deliverInspectionOnce(inspect)
      } finally {
        inspectionsInFlight.delete(inspect.inspectId)
      }
    }

    const deliverInspectionOnce = async (inspect: InspectEvent): Promise<void> => {
      // Another session's query stays pending; the session effect claims it
      // after the user routes back. Never answer from the wrong viewer.
      if (disposed || inspect.sessionID !== currentSessionID()) return
      const session = ctx.sessions.current()
      if (session?.id !== inspect.sessionID) return
      const rpc = rpcOf(session)
      await refresh(session)
      if (disposed || inspect.sessionID !== currentSessionID()) return
      // The query samples live Mol* state, so its viewer must exist. Reveal the
      // tab first, like a capture, and answer only after the command queue has
      // drained: an inspection must not describe a half-applied style.
      openTab(session, inspect.path, false)
      const live = await waitForViewer(inspect.sceneId, 15_000)
      if (disposed || inspect.sessionID !== currentSessionID()) return
      if (live === undefined) {
        await rpc.deliverInspect(
          {
            inspectId: inspect.inspectId,
            ok: false,
            message:
              'the structure viewer tab is not available; open the molecular viewer from the side panel and retry mol_inspect',
          },
          optionsOf(session),
        )
        return
      }
      try {
        await live.whenIdle()
        if (disposed || inspect.sessionID !== currentSessionID()) return
        const result = live.viewer.inspect(requestOf(inspect))
        await rpc.deliverInspect({ inspectId: inspect.inspectId, ok: true, result }, optionsOf(session))
      } catch (reason) {
        if (disposed || inspect.sessionID !== currentSessionID()) return
        await rpc.deliverInspect(
          {
            inspectId: inspect.inspectId,
            ok: false,
            message: reason instanceof Error ? reason.message : String(reason),
          },
          optionsOf(session),
        )
      }
    }

    const deliverTmScore = async (query: TmScoreEvent): Promise<void> => {
      if (tmScoresInFlight.has(query.tmScoreId)) return
      tmScoresInFlight.add(query.tmScoreId)
      try {
        await deliverTmScoreOnce(query)
      } finally {
        tmScoresInFlight.delete(query.tmScoreId)
      }
    }

    const deliverTmScoreOnce = async (query: TmScoreEvent): Promise<void> => {
      if (disposed || query.sessionID !== currentSessionID()) return
      const session = ctx.sessions.current()
      if (session?.id !== query.sessionID) return
      const rpc = rpcOf(session)
      await refresh(session)
      if (disposed || query.sessionID !== currentSessionID()) return
      openTab(session, query.path, false)
      const live = await waitForViewer(query.sceneId, 15_000)
      if (disposed || query.sessionID !== currentSessionID()) return
      if (live === undefined) {
        await rpc.deliverTmScore(
          {
            tmScoreId: query.tmScoreId,
            ok: false,
            message:
              'the structure viewer tab is not available; open the molecular viewer from the side panel and retry mol_tmscore',
          },
          optionsOf(session),
        )
        return
      }
      try {
        await live.whenIdle()
        if (disposed || query.sessionID !== currentSessionID()) return
        const result = live.viewer.tmScore({ reference: query.reference, target: query.target })
        await rpc.deliverTmScore({ tmScoreId: query.tmScoreId, ok: true, result }, optionsOf(session))
      } catch (reason) {
        if (disposed || query.sessionID !== currentSessionID()) return
        await rpc.deliverTmScore(
          {
            tmScoreId: query.tmScoreId,
            ok: false,
            message: reason instanceof Error ? reason.message : String(reason),
          },
          optionsOf(session),
        )
      }
    }

    /** RPC events are live-only, so claim captures queued before this route. */
    const claimPending = async (session: SessionRef | undefined): Promise<void> => {
      if (session === undefined || session.id === '') return
      const sessionID = session.id
      try {
        const pending = (await rpcOf(session).pendingCaptures({ sessionID }, optionsOf(session))) as unknown as {
          captures: readonly CaptureRequest[]
        }
        if (disposed || sessionID !== currentSessionID()) return
        for (const capture of pending.captures) void deliver({ ...capture, sessionID })
      } catch {
        // Capture claim is best-effort.
      }
      try {
        const pending = (await rpcOf(session).pendingInspections({ sessionID }, optionsOf(session))) as unknown as {
          inspections: readonly InspectRequestEvent[]
        }
        if (disposed || sessionID !== currentSessionID()) return
        for (const inspect of pending.inspections) void deliverInspection({ ...inspect, sessionID })
      } catch {
        // Inspection claim is best-effort.
      }
      try {
        const pending = (await rpcOf(session).pendingTmScores({ sessionID }, optionsOf(session))) as unknown as {
          queries: readonly TmScoreRequestEvent[]
        }
        if (disposed || sessionID !== currentSessionID()) return
        for (const query of pending.queries) void deliverTmScore({ ...query, sessionID })
      } catch {
        // TM-score claim is best-effort.
      }
    }

    const handleScene = (data: SceneEvent | undefined): void => {
      const route = routeSceneEvent(currentSessionID(), data)
      if (route.action === 'ignore') return
      if (route.action === 'queue') {
        // The agent opened a structure while another session is routed; open it
        // when the user switches there instead of dropping the event.
        pendingOpen.set(route.sessionID, route.path)
        return
      }
      const session = ctx.sessions.current()
      if (session === undefined || session.id !== route.sessionID) return
      void refresh(session).then(() => {
        if (disposed) return
        if (route.sessionID !== currentSessionID()) {
          // Routed away while refreshing: keep the open for the next visit.
          if (route.path !== undefined) pendingOpen.set(route.sessionID, route.path)
          return
        }
        // Always reopen on `open` (also when the active path is unchanged, e.g.
        // the user closed the tab and `mol_open` reopened the same file).
        if (route.path !== undefined) openTab(ctx.sessions.current(), route.path, true)
      })
    }

    const handleCapture = (data: CaptureEvent | undefined): void => {
      if (data?.sessionID !== undefined && data.sessionID !== currentSessionID()) return
      if (data !== undefined) void deliver(data)
    }

    const handleInspect = (data: InspectEvent | undefined): void => {
      if (data?.sessionID !== undefined && data.sessionID !== currentSessionID()) return
      if (data !== undefined) void deliverInspection(data)
    }

    const handleTmScore = (data: TmScoreEvent | undefined): void => {
      if (data?.sessionID !== undefined && data.sessionID !== currentSessionID()) return
      if (data !== undefined) void deliverTmScore(data)
    }

    createEffect(() => {
      const session = ctx.sessions.current()
      const key = session?.key ?? ''
      if (key === lastSessionKey) return
      lastSessionKey = key
      if (session === undefined) return
      void (async () => {
        await refresh(session)
        if (disposed || session.key !== (ctx.sessions.current()?.key ?? '')) return
        const path = pendingOpen.get(session.id)
        if (path !== undefined) {
          pendingOpen.delete(session.id)
          openTab(session, path, true)
        }
        await claimPending(session)
      })()
    })

    /**
     * RPC events are broadcast per server. Subscribe on every server that has an
     * open session, not just the routed one, so an `mol_open` in a background
     * session can still queue its tab. Re-subscribe when a server restarts and
     * hands out a new client.
     */
    const watches = new Map<string, ServerWatch>()
    createEffect(() => {
      const live = new Set<string>()
      for (const session of ctx.sessions.list()) {
        const server = ctx.servers.get(session.server.id) ?? session.server
        live.add(server.id)
        const client = server.client
        const watch = watches.get(server.id)
        if (watch?.client === client) continue
        watch?.offs.forEach(off => off())
        const rpc = client.rpc(Mol4Agent)
        watches.set(server.id, {
          client,
          offs: [
            rpc.events.on('scene', (event) => handleScene((event as unknown as { data: SceneEvent }).data)),
            rpc.events.on('capture', (event) => handleCapture((event as unknown as { data: CaptureEvent }).data)),
            rpc.events.on('inspect', (event) => handleInspect((event as unknown as { data: InspectEvent }).data)),
            rpc.events.on('tmScore', (event) => handleTmScore((event as unknown as { data: TmScoreEvent }).data)),
          ],
        })
      }
      for (const [id, watch] of watches) {
        if (live.has(id)) continue
        watch.offs.forEach(off => off())
        watches.delete(id)
      }
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
    const linkedPaths = new Map<string, string>()
    ctx.add(LinkHandler, {
      priority: 10,
      match: (link) => {
        if (isRemoteLink(link.href)) return false
        // Only exact workspace files or path-like text: a bare `foo.pdb` in
        // prose must not become a link.
        if (link.exact !== true && !isPathLike(link.href)) return false
        const hit = MOLECULAR_HREF.test(link.href)
        if (hit && isPathLike(link.href)) linkedPaths.set(basenameOf(link.href), hrefToPath(link.href))
        return hit
      },
      open: (link) => {
        if (isRemoteLink(link.href)) return
        const href = hrefToPath(link.href)
        const resolved = isPathLike(href) ? href : (linkedPaths.get(basenameOf(href)) ?? href)
        const session = link.session ?? ctx.sessions.current()
        if (session === undefined) {
          ctx.toast.show({
            variant: 'error',
            title: 'Could not open structure',
            description: 'No session is routed; open the structure from a session.',
          })
          return
        }
        // Send the path and the link base unchanged. The server that owns the
        // session resolves them in its own namespace; the desktop may be a
        // different machine or OS from that server.
        void rpcOf(session).openPath({ path: resolved, base: link.base, sessionID: session.id }, optionsOf(session)).then((raw) => {
          const result = raw as { ok: boolean; path?: string; tab?: string; error?: string }
          if (!result.ok) {
            ctx.toast.show({ variant: 'error', title: 'Could not open structure', description: result.error })
            return
          }
          if (result.tab !== undefined) openTab(session, result.tab, link.background === true)
        })
      },
      exists: (link) => {
        if (isRemoteLink(link.href)) return false
        // The GUI has no filesystem, so only claim links the host marked exact
        // or that are visibly paths.
        return link.exact === true || isPathLike(link.href)
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
        if (session === undefined) return
        // The system picker names a file on this computer. That is the session
        // server's namespace only when the server is local to this machine.
        if (session.server.local === false) {
          ctx.toast.show({
            variant: 'error',
            title: 'Cannot pick a file on the session server',
            description:
              'The file picker selects files on this computer. For a remote server, use Ctrl+P file search, click a .pdb/.cif path in the conversation, or ask the agent to run mol_open.',
          })
          return
        }
        const picked = await ctx.desktop.pick({ extensions: EXTENSIONS, multiple: false })
        const path = picked?.[0]
        if (!path) return
        const result = (await rpcOf(session).openPath({ path, sessionID: session.id }, optionsOf(session))) as unknown as {
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
      for (const watch of watches.values()) watch.offs.forEach(off => off())
      watches.clear()
      pool.disposeAll()
      for (const live of viewers.values()) live.viewer.dispose()
      viewers.clear()
      registeredAt.clear()
      pendingOpen.clear()
      inFlight.clear()
      inspectionsInFlight.clear()
      tmScoresInFlight.clear()
      tabs.clear()
    }
  },
})
