/**
 * OpenCode 2 GUI part for mol4agent: a side panel with one Mol* viewer tab per
 * open structure, the launcher, a pick-file command, and a `LinkHandler`
 * (Ctrl+P file search, the `/open` command).
 *
 * There is deliberately no `/mol_open` slash command: its name collides with
 * the agent tool `mol_open`, and Ctrl+P plus the pick-file command cover the
 * human paths.
 *
 * Built without JSX (esbuild + `createComponent` + imperative DOM): Solid 1.9
 * has no standalone JSX runtime, and the GUI must keep core's chunk lazy so
 * Mol*'s Markdown dependency never runs in the Electron main process.
 *
 * @module @gcszhn/mol4agent-opencode/gui
 */
import { Plugin, Panel, Command, MenuItem, LinkHandler } from '@opencode/plugin/gui'
import { createComponent, createSignal } from 'solid-js'
import { createStore } from 'solid-js/store'
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

export default Plugin.define({
  setup(ctx) {
    const rpc = ctx.client.rpc(Mol4Agent)
    const [scenes, setScenes] = createStore<Record<string, SceneInfo>>({})
    const [active, setActive] = createSignal('')

    /** Live viewers keyed by sceneId, for capture delivery. */
    const viewers = new Map<string, MolViewer>()
    /** When each scene's viewer was registered, so a fresh mount can settle. */
    const registeredAt = new Map<string, number>()

    /** `load()` starts a 250 ms camera-focus animation; a capture before it ends
     *  can render only the background, so let a freshly registered viewer settle. */
    const FIRST_FRAME_SETTLE_MS = 400

    const currentSessionID = (): string => ctx.sessions.current()?.id ?? ''

    const applyScenes = (list: SceneList): void => {
      const next: Record<string, SceneInfo> = {}
      for (const scene of list.scenes) next[scene.path] = scene
      setScenes(next)
      setActive(list.active)
    }

    const refresh = async (): Promise<void> => {
      try {
        applyScenes((await rpc.listScenes({ sessionID: currentSessionID() })) as unknown as SceneList)
      } catch (reason) {
        console.warn('[mol4agent] could not list scenes', reason)
      }
    }

    const openTab = (path: string, background: boolean): void => {
      const session = ctx.sessions.current()
      if (session && path) {
        ctx.layout.open(`${ctx.id}:${path}`, session, { tab: 'select', ...(background ? { background: true } : {}) })
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

    const deliver = async (capture: CaptureRequest): Promise<void> => {
      // Ensure the scene store has this scene (the panel `list` filters through
      // it), then reveal the target tab so its viewer mounts. A freshly mounted
      // viewer loads Mol*, so allow well over the 5 s a warm tab needs.
      await refresh()
      openTab(capture.path, false)
      const viewer = await waitForViewer(capture.sceneId, 15_000)
      if (viewer === undefined) {
        await rpc.failCapture({
          captureId: capture.captureId,
          message:
            'the structure viewer tab is not visible; open the molecular viewer from the side panel and retry mol_capture',
        })
        return
      }
      const since = registeredAt.get(capture.sceneId)
      const settle = since === undefined ? 0 : FIRST_FRAME_SETTLE_MS - (Date.now() - since)
      if (settle > 0) await new Promise(resolve => setTimeout(resolve, settle))
      try {
        const png = await viewer.capture({ width: capture.width, height: capture.height, transparent: capture.transparent })
        await rpc.deliverCapture({ captureId: capture.captureId, data: bytesToBase64(png), width: capture.width, height: capture.height })
      } catch (reason) {
        await rpc.failCapture({ captureId: capture.captureId, message: reason instanceof Error ? reason.message : String(reason) })
      }
    }

    void (async () => {
      await refresh()
      // RPC events are live-only; claim any capture still pending for this
      // session so a GUI that (re)mounted mid-capture still delivers it.
      try {
        const pending = (await rpc.pendingCaptures({ sessionID: currentSessionID() })) as unknown as {
          captures: readonly CaptureRequest[]
        }
        for (const capture of pending.captures) void deliver(capture)
      } catch {
        // Capture claim is best-effort.
      }
    })()

    const offScene = rpc.events.on('scene', (event) => {
      const data = (event as unknown as { data: { sessionID?: string } }).data
      if (data?.sessionID !== undefined && data.sessionID !== currentSessionID()) return
      const before = active()
      void refresh().then(() => {
        const after = active()
        if (after !== '' && after !== before) openTab(after, true)
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
      list: (input) => input.open
        .map(id => scenes[id])
        .filter((scene): scene is SceneInfo => scene !== undefined)
        .map(scene => ({ id: scene.path, title: scene.label })),
      render: (props) => {
        const path = props.tab.id
        return createComponent(StructureViewer, {
          scene: (): SceneInfo | undefined => scenes[path],
          fetchScene: async (sceneId: string) => (await rpc.fetchScene({ sceneId })) as unknown as FetchedScene,
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
    const hrefToPath = (href: string): string => {
      if (!href.startsWith('file://')) return href
      try {
        return decodeURIComponent(href.slice('file://'.length))
      } catch {
        return href.slice('file://'.length)
      }
    }
    const isRemote = (href: string): boolean => /^[a-z][a-z0-9+.-]*:/iu.test(href) && !href.startsWith('file://')
    const isPath = (href: string): boolean => /[\\/]/.test(href)
    const basenameOf = (href: string): string => {
      const path = hrefToPath(href).replaceAll('\\', '/')
      return path.slice(path.lastIndexOf('/') + 1)
    }
    const linkedPaths = new Map<string, string>()
    ctx.add(LinkHandler, {
      priority: 10,
      match: (link) => {
        if (isRemote(link.href)) return false
        const hit = MOLECULAR_HREF.test(link.href)
        if (hit && isPath(link.href)) linkedPaths.set(basenameOf(link.href), hrefToPath(link.href))
        return hit
      },
      open: (link) => {
        if (isRemote(link.href)) return
        const href = hrefToPath(link.href)
        const path = isPath(href) ? href : (linkedPaths.get(href) ?? href)
        const session = ctx.sessions.current()
        void rpc.openPath({ path, cwd: session?.directory, sessionID: currentSessionID() }).then((raw) => {
          const result = raw as { ok: boolean; error?: string }
          if (!result.ok) ctx.toast.show({ variant: 'error', title: 'Could not open structure', description: result.error })
        })
      },
      exists: (link) => !isRemote(link.href),
    })

    ctx.add(MenuItem, () => {
      const session = ctx.sessions.current()
      return {
        menu: 'session.panel' as const,
        id: 'structure',
        title: 'Molecular viewer',
        icon: 'flask' as const,
        run: () => {
          if (!session) return
          if (active() !== '') ctx.layout.open(`${ctx.id}:${active()}`, session)
          else ctx.toast.show({ title: 'No structure open', description: 'Use mol_open or the "Open molecular structure" command.' })
        },
      }
    })

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
          error?: string
        }
        if (!result.ok) {
          ctx.toast.show({ variant: 'error', title: 'Could not open structure', description: result.error })
        }
      },
    }))

    return () => {
      offScene()
      offCapture()
      for (const viewer of viewers.values()) viewer.dispose()
      viewers.clear()
      registeredAt.clear()
    }
  },
})
