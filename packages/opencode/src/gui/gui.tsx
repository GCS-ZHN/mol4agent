/**
 * OpenCode 2 GUI part for mol4agent: a side panel with one Mol* viewer tab per
 * open structure, plus a launcher and an "Open molecular structure" command.
 *
 * The server part owns paths/bytes and the scene log; this window part renders
 * core's official viewer and renders/delivers screenshots on request.
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

const EXTENSIONS = ['pdb', 'ent', 'pdbqt', 'pqr', 'cif', 'mmcif', 'mcif', 'bcif', 'mol', 'sdf', 'sd', 'mol2', 'xyz', 'gro']

interface SceneList {
  readonly active: string
  readonly scenes: readonly SceneInfo[]
}

interface CaptureEvent {
  readonly captureId: string
  readonly sceneId: string
  readonly width: number
  readonly height: number
  readonly transparent: boolean
}

export default Plugin.define({
  setup(ctx) {
    const rpc = ctx.client.rpc(Mol4Agent)
    const [scenes, setScenes] = createStore<Record<string, SceneInfo>>({})
    const [active, setActive] = createSignal('')

    /** Live viewers keyed by sceneId, for capture delivery. */
    const viewers = new Map<string, MolViewer>()

    const applyScenes = (list: SceneList): void => {
      const next: Record<string, SceneInfo> = {}
      for (const scene of list.scenes) next[scene.path] = scene
      setScenes(next)
      setActive(list.active)
    }

    const refresh = async (): Promise<void> => {
      try {
        applyScenes((await rpc.listScenes({})) as unknown as SceneList)
      } catch (reason) {
        console.warn('[mol4agent] could not list scenes', reason)
      }
    }

    const openActive = (background: boolean): void => {
      const session = ctx.sessions.current()
      const path = active()
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

    const deliver = async (capture: CaptureEvent): Promise<void> => {
      const viewer = await waitForViewer(capture.sceneId, 5000)
      if (viewer === undefined) {
        await rpc.failCapture({
          captureId: capture.captureId,
          message: 'the structure viewer is not open; open the structure with mol_open first',
        })
        return
      }
      try {
        const png = await viewer.capture({ width: capture.width, height: capture.height, transparent: capture.transparent })
        await rpc.deliverCapture({ captureId: capture.captureId, data: bytesToBase64(png), width: capture.width, height: capture.height })
      } catch (reason) {
        await rpc.failCapture({ captureId: capture.captureId, message: reason instanceof Error ? reason.message : String(reason) })
      }
    }

    void refresh()
    const offScene = rpc.events.on('scene', () => {
      const before = active()
      void refresh().then(() => {
        const after = active()
        if (after !== '' && after !== before) openActive(true)
      })
    })
    const offCapture = rpc.events.on('capture', (event) => {
      void deliver((event as unknown as { data: CaptureEvent }).data)
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
            if (viewer !== undefined) viewers.set(sceneId, viewer)
            else viewers.delete(sceneId)
          },
        })
      },
    })

    // Intercept clicks on a molecular file/link and open it in the Mol* panel.
    // The file tree calls `match` with the absolute path but `open` with only
    // the basename, so cache the full path from `match` and use it in `open`.
    const MOLECULAR_HREF = /\.(pdb|ent|pdbqt|pqr|cif|mmcif|mcif|bcif|mol|sdf|sd|mol2|xyz|gro)(\.gz)?$/iu
    const hrefToPath = (href: string): string =>
      href.startsWith('file://') ? decodeURIComponent(href.slice('file://'.length)) : href
    const isPath = (href: string): boolean => /[\\/]/.test(href)
    const basenameOf = (href: string): string => {
      const path = hrefToPath(href).replaceAll('\\', '/')
      return path.slice(path.lastIndexOf('/') + 1)
    }
    const linkedPaths = new Map<string, string>()
    ctx.add(LinkHandler, {
      priority: 10,
      match: (link) => {
        const hit = MOLECULAR_HREF.test(link.href)
        if (hit && isPath(link.href)) linkedPaths.set(basenameOf(link.href), hrefToPath(link.href))
        return hit
      },
      open: (link) => {
        const href = hrefToPath(link.href)
        const path = isPath(href) ? href : (linkedPaths.get(href) ?? href)
        const session = ctx.sessions.current()
        void rpc.openPath({ path, cwd: session?.directory }).then((raw) => {
          const result = raw as { ok: boolean; error?: string }
          if (!result.ok) ctx.toast.show({ variant: 'error', title: 'Could not open structure', description: result.error })
        })
      },
      exists: () => true,
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
        const result = (await rpc.openPath({ path, cwd: session?.directory })) as unknown as { ok: boolean; error?: string }
        if (!result.ok) {
          ctx.toast.show({ variant: 'error', title: 'Could not open structure', description: result.error })
        }
      },
    }))

    ctx.add(Command, () => ({
      id: 'mol-open-path',
      title: 'Open a molecular structure by path',
      description: 'Open a .pdb/.cif/... path in the Mol* viewer, e.g. /mol_open fixtures/1atp.pdb',
      keywords: 'mol open pdb cif path slash',
      slash: { name: 'mol_open', arguments: true as const },
      run: (input) => {
        const path = (input ?? '').trim()
        if (path === '') {
          ctx.toast.show({ title: 'mol_open', description: 'Usage: /mol_open <path>' })
          return
        }
        const session = ctx.sessions.current()
        void rpc.openPath({ path, cwd: session?.directory }).then((raw) => {
          const result = raw as { ok: boolean; error?: string }
          if (!result.ok) ctx.toast.show({ variant: 'error', title: 'Could not open structure', description: result.error })
        })
      },
    }))

    return () => {
      offScene()
      offCapture()
      for (const viewer of viewers.values()) viewer.dispose()
      viewers.clear()
    }
  },
})
