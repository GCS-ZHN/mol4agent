/**
 * OpenCode 2 server part for mol4agent: registers the `mol_*` tools and the
 * `mol4agent` RPC that the GUI panel talks to. Paths, bytes, and the scene log
 * live here; core receives only `{ data, format, label }` plus JSON commands.
 *
 * @module @gcszhn/mol4agent-opencode
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Plugin } from '@opencode/plugin'
import type { MolCommand, StructureSelector } from '@gcszhn/mol4agent-core/protocol'
import { base64ToBytes } from './base64.ts'
import { CaptureHub } from './capture.ts'
import { findInterfaceResidues } from './interface.ts'
import { resolveMoleculeFile } from './paths.ts'
import { Mol4Agent } from './rpc.ts'
import { SceneStore } from './scene.ts'
import { normalizeSelector } from './selector.ts'
import {
  MEASUREMENT_KINDS,
  SELECTOR_SCHEMA,
  STYLE_SCHEMA,
  describeFile,
  describeSelector,
  describeStyle,
  formatInterface,
  styleOf,
  summarizeSafely,
  validateSelectorAgainst,
} from './tools.ts'

const MAX_FILE_BYTES = 64 * 1024 * 1024
const DEFAULT_CAPTURE_WIDTH = 1024
const DEFAULT_CAPTURE_HEIGHT = 768
const CAPTURE_TIMEOUT_MS = readPositiveInt('MOL4AGENT_CAPTURE_TIMEOUT_MS', 45_000)

/**
 * Process-wide scene log and capture hub.
 *
 * OpenCode loads a plugin once per location (and re-evaluates the module per
 * location), so neither closure state nor module state is shared across
 * locations. The molecular scene must be a single store: `mol_open` runs in the
 * agent's location while the GUI panel lives in the desktop app's location, and
 * both must agree on the same scenes. RPC events already broadcast across
 * locations; pinning these two singletons on `globalThis` makes the RPC
 * *methods* agree too, within this server process.
 */
const globalKey = '__mol4agent_opencode__'
const g = globalThis as unknown as Record<string, unknown>
const store = (g[`${globalKey}store`] ??= new SceneStore()) as SceneStore
const captures = (g[`${globalKey}captures`] ??= new CaptureHub()) as CaptureHub

const INSTRUCTIONS = `mol4agent provides an interactive 3D molecular viewer inside the OpenCode side panel.

- Use mol_info before choosing chains or residues; never read a whole PDB/mmCIF file as plain text.
- Use mol_open to display a structure; the viewer opens in the side panel and stays live.
- Use mol_style, mol_select, mol_focus, and mol_measure to operate the open structure.
- Use mol_capture to render a PNG screenshot; the viewer must be open.
- Selectors are JSON objects such as {"kind":"ligand"}, {"kind":"chain","chain":"A"},
  {"kind":"residues","chain":"A","start":10,"end":25}, or {"kind":"comp","compId":"ATP"}.
- Paths may be absolute or relative to the session workspace directory.`

export default Plugin.define({
  id: 'mol4agent-opencode',
  async setup(ctx) {
    const activeScene = (): ReturnType<SceneStore['snapshotActive']> => store.snapshotActive()
    const requireScene = (action: string) => {
      const scene = activeScene()
      if (scene === null) throw new Error(`open a structure with mol_open before trying to ${action} it`)
      return scene
    }

    const sessionDirectory = async (sessionID: string): Promise<string> => {
      try {
        const session = await ctx.session.get({ sessionID })
        if (session.location?.directory) return session.location.directory
      } catch (reason) {
        console.warn('[mol4agent] could not read the session directory', reason)
      }
      return process.cwd()
    }

    // ---- RPC (GUI <-> server) ---------------------------------------------

    const registration = await ctx.rpc.register(Mol4Agent, {
      async listScenes() {
        return store.list()
      },
      async fetchScene(input) {
        const { sceneId } = input as { sceneId: string }
        const data = store.fetch(sceneId)
        if (data === undefined) throw new Error(`structure scene ${sceneId} is no longer available`)
        return data
      },
      async openPath(input) {
        const { path, cwd } = input as { path: string; cwd?: string }
        try {
          const base = cwd ?? process.cwd()
          const file = await resolveMoleculeFile(base, path, MAX_FILE_BYTES, new AbortController().signal)
          store.open({
            path: file.absolutePath,
            label: file.label,
            format: file.format,
            bytes: file.bytes,
            commands: [{ op: 'represent', style: { type: 'cartoon', color: 'chain-id' } }],
          })
          emitScene()
          return { ok: true, path: file.absolutePath }
        } catch (reason) {
          return { ok: false, error: reason instanceof Error ? reason.message : String(reason) }
        }
      },
      async deliverCapture(input) {
        const { captureId, data, width, height } = input as {
          captureId: string
          data: string
          width: number
          height: number
        }
        try {
          const png = decodePng(data)
          const saveDir = captures.saveDirOf(captureId) ?? process.cwd()
          const path = await saveCapture(saveDir, captureId, png)
          if (!captures.deliver(captureId, { png, width, height, path })) {
            return { ok: false, path }
          }
          return { ok: true, path }
        } catch (reason) {
          captures.fail(captureId, reason instanceof Error ? reason.message : String(reason))
          return { ok: false, path: '' }
        }
      },
      async failCapture(input) {
        const { captureId, message } = input as { captureId: string; message: string }
        captures.fail(captureId, message)
        return {}
      },
    })

    const emitScene = (): void => {
      void registration.events.emit('scene', {})
    }
    const emitCapture = (capture: {
      captureId: string
      sceneId: string
      width: number
      height: number
      transparent: boolean
    }): void => {
      void registration.events.emit('capture', capture)
    }

    // ---- Tools --------------------------------------------------------------

    await ctx.tool.transform((editor) => {
      editor.add({
        name: 'mol_info',
        description:
          'Summarize a molecular structure file (PDB, mmCIF, SDF, MOL2, XYZ, GRO, ...) without opening '
          + 'the viewer. Returns chains, residue/atom counts, and ligands. Use it before choosing chains '
          + 'or residues; never read a whole structure file as plain text.',
        input: {
          type: 'object',
          properties: { path: { type: 'string', minLength: 1 } },
          required: ['path'],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const { path } = input as { path: string }
          const cwd = await sessionDirectory(context.sessionID)
          const file = await resolveMoleculeFile(cwd, path, MAX_FILE_BYTES, context.signal)
          return { content: `${describeFile(file)}\n\nUse mol_open to display it in the viewer.` }
        },
      })

      editor.add({
        name: 'mol_interface',
        description:
          'Find interface residues between two chain groups within a distance cutoff (default 8 A). '
          + 'Returns residue ranges usable as mol_style targets. Currently supports PDB-like ATOM files '
          + '(pdb/pdbqt/pqr).',
        input: {
          type: 'object',
          properties: {
            path: { type: 'string', minLength: 1 },
            chainsA: { type: 'array', items: { type: 'string' }, minItems: 1 },
            chainsB: { type: 'array', items: { type: 'string' }, minItems: 1 },
            cutoff: { type: 'number', minimum: 0.1, maximum: 30 },
          },
          required: ['path', 'chainsA', 'chainsB'],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const { path, chainsA, chainsB, cutoff } = input as {
            path: string
            chainsA: string[]
            chainsB: string[]
            cutoff?: number
          }
          const cwd = await sessionDirectory(context.sessionID)
          const file = await resolveMoleculeFile(cwd, path, MAX_FILE_BYTES, context.signal)
          if (file.format !== 'pdb' && file.format !== 'pdbqt' && file.format !== 'pqr') {
            throw new Error(`interface calculation supports PDB-like ATOM files only; received ${file.format}`)
          }
          const a = chainsA.map(chain => chain.trim()).filter(Boolean)
          const b = chainsB.map(chain => chain.trim()).filter(Boolean)
          if (a.length === 0 || b.length === 0) throw new Error('chainsA and chainsB must not be empty')
          return { content: formatInterface(file.label, findInterfaceResidues(file.bytes, { chainsA: a, chainsB: b, cutoff: cutoff ?? 8 })) }
        },
      })

      editor.add({
        name: 'mol_open',
        description:
          'Open a molecular structure in the mol4agent 3D viewer (in the side panel) and make it the '
          + 'active scene. Optionally set the representation/color and highlight a selection. The viewer '
          + 'updates when later mol_style/mol_select/mol_focus/mol_measure calls run.',
        input: {
          type: 'object',
          properties: {
            path: { type: 'string', minLength: 1 },
            ...STYLE_SCHEMA,
            select: SELECTOR_SCHEMA,
            focus: { type: 'boolean' },
          },
          required: ['path'],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const args = input as {
            path: string
            type?: string
            color?: string
            colorParams?: { value: string | number }
            select?: unknown
            focus?: boolean
          }
          const cwd = await sessionDirectory(context.sessionID)
          const style = styleOf({ type: args.type as never, color: args.color as never, colorParams: args.colorParams })
          const file = await resolveMoleculeFile(cwd, args.path, MAX_FILE_BYTES, context.signal)
          const commands: MolCommand[] = [{ op: 'represent', style }]
          const target = args.select === undefined ? undefined : normalizeSelector(args.select)
          if (target !== undefined) {
            const summary = summarizeSafely(file.bytes, file.format)
            validateSelectorAgainst(summary, file.bytes, file.format, target)
            commands.push({ op: 'select', target, mode: 'highlight', ...(args.focus === true ? { focus: true } : {}) })
          } else if (args.focus === true) {
            commands.push({ op: 'focus' })
          }
          store.open({
            path: file.absolutePath,
            label: file.label,
            format: file.format,
            bytes: file.bytes,
            commands,
          })
          emitScene()
          return {
            content:
              `${describeFile(file)}\n\nOpened ${file.label} in the mol4agent viewer. `
              + 'Use mol_style, mol_select, mol_focus, mol_measure, or mol_capture to operate it.',
          }
        },
      })

      editor.add({
        name: 'mol_style',
        description:
          'Change the representation or color theme of the active structure. Without target this replaces '
          + 'the scene representation; with target it adds a representation only to that selection.',
        input: {
          type: 'object',
          properties: { ...STYLE_SCHEMA, target: SELECTOR_SCHEMA },
          additionalProperties: false,
        },
        execute: async (input) => {
          const args = input as {
            type?: string
            color?: string
            colorParams?: { value: string | number }
            target?: unknown
          }
          requireScene('style')
          const target = args.target === undefined ? undefined : normalizeSelector(args.target)
          const scene = activeScene()
          if (target !== undefined && scene !== null) {
            const record = store.recordBySceneId(scene.sceneId)
            if (record !== undefined) validateSelectorAgainst(record.summary, record.bytes, record.format, target)
          }
          store.pushActive({
            op: 'represent',
            style: styleOf({ type: args.type as never, color: args.color as never, colorParams: args.colorParams }),
            ...(target === undefined ? {} : { target }),
          })
          emitScene()
          return { content: describeStyle({ type: args.type as never, color: args.color as never, target }) }
        },
      })

      editor.add({
        name: 'mol_select',
        description: 'Select, highlight, or focus part of the active structure.',
        input: {
          type: 'object',
          properties: {
            target: SELECTOR_SCHEMA,
            mode: { enum: ['select', 'highlight'] },
            focus: { type: 'boolean' },
          },
          required: ['target'],
          additionalProperties: false,
        },
        execute: async (input) => {
          const args = input as { target: unknown; mode?: 'select' | 'highlight'; focus?: boolean }
          requireScene('select')
          const target = normalizeSelector(args.target)
          const scene = activeScene()
          if (scene !== null) {
            const record = store.recordBySceneId(scene.sceneId)
            if (record !== undefined) validateSelectorAgainst(record.summary, record.bytes, record.format, target)
          }
          store.pushActive({
            op: 'select',
            target,
            mode: args.mode ?? 'select',
            ...(args.focus === true ? { focus: true } : {}),
          })
          emitScene()
          return {
            content:
              `${args.mode === 'highlight' ? 'Highlighted' : 'Selected'} ${describeSelector(target)}`
              + `${args.focus === true ? ' and focused the camera' : ''}.`,
          }
        },
      })

      editor.add({
        name: 'mol_focus',
        description: 'Move the camera to a selection, or to the whole structure when target is omitted.',
        input: {
          type: 'object',
          properties: { target: SELECTOR_SCHEMA },
          additionalProperties: false,
        },
        execute: async (input) => {
          const args = input as { target?: unknown }
          requireScene('focus')
          const target = args.target === undefined ? undefined : normalizeSelector(args.target)
          if (target !== undefined) {
            const scene = activeScene()
            if (scene !== null) {
              const record = store.recordBySceneId(scene.sceneId)
              if (record !== undefined) validateSelectorAgainst(record.summary, record.bytes, record.format, target)
            }
          }
          store.pushActive({ op: 'focus', ...(target === undefined ? {} : { target }) })
          emitScene()
          return {
            content: target === undefined ? 'Focused the whole structure.' : `Focused ${describeSelector(target)}.`,
          }
        },
      })

      editor.add({
        name: 'mol_measure',
        description:
          'Add a distance (exactly 2 targets), angle (exactly 3 targets), or dihedral (exactly 4 targets) '
          + 'measurement between atomic selections in the active viewer.',
        input: {
          type: 'object',
          properties: {
            kind: { enum: ['distance', 'angle', 'dihedral'] },
            targets: { type: 'array', items: SELECTOR_SCHEMA, minItems: 2, maxItems: 4 },
          },
          required: ['kind', 'targets'],
          additionalProperties: false,
        },
        execute: async (input) => {
          const args = input as { kind: 'distance' | 'angle' | 'dihedral'; targets: unknown[] }
          requireScene('measure')
          const needed = args.kind === 'distance' ? 2 : args.kind === 'angle' ? 3 : 4
          if (args.targets.length !== needed) {
            throw new Error(`${args.kind} needs exactly ${needed} targets; got ${args.targets.length}`)
          }
          const targets: StructureSelector[] = args.targets.map(target => normalizeSelector(target))
          for (const target of targets) {
            if (!MEASUREMENT_KINDS.has(target.kind)) {
              throw new Error(`measure targets must be chain/residue/residues/comp/schema selectors; received ${target.kind}`)
            }
          }
          const scene = activeScene()
          if (scene !== null) {
            const record = store.recordBySceneId(scene.sceneId)
            if (record !== undefined) {
              for (const target of targets) validateSelectorAgainst(record.summary, record.bytes, record.format, target)
            }
          }
          store.pushActive({ op: 'measure', kind: args.kind, targets })
          emitScene()
          return { content: `Added a ${args.kind} measurement.` }
        },
      })

      editor.add({
        name: 'mol_capture',
        description:
          'Capture the current molecular viewer viewport as a PNG and save it under `.mol4agent/captures/`. '
          + 'The viewer must be open. Use it to visually verify a view or produce a figure.',
        input: {
          type: 'object',
          properties: {
            width: { type: 'integer', minimum: 64, maximum: 4096 },
            height: { type: 'integer', minimum: 64, maximum: 4096 },
            transparent: { type: 'boolean' },
          },
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const args = input as { width?: number; height?: number; transparent?: boolean }
          const scene = requireScene('capture')
          const width = args.width ?? DEFAULT_CAPTURE_WIDTH
          const height = args.height ?? DEFAULT_CAPTURE_HEIGHT
          const cwd = await sessionDirectory(context.sessionID)
          const pending = captures.enqueue({
            scene,
            width,
            height,
            transparent: args.transparent === true,
            saveDir: cwd,
          })
          emitCapture({
            captureId: pending.captureId,
            sceneId: scene.sceneId,
            width,
            height,
            transparent: args.transparent === true,
          })
          const delivery = await captures.wait(pending.captureId, CAPTURE_TIMEOUT_MS, context.signal)
          const text = `Screenshot of ${scene.label} saved to ${delivery.path} (${delivery.width}x${delivery.height} px).`
          return {
            content: [
              { type: 'text', text },
              { type: 'file', uri: pathToFileURL(delivery.path).href, mime: 'image/png', name: `mol4agent-${pending.captureId.slice(0, 8)}.png` },
            ],
          }
        },
      })
    })

    console.log(`[mol4agent] OpenCode adapter initialized (${ctx.app.version})`)

    return () => {}
  },
})

async function saveCapture(root: string, captureId: string, png: Uint8Array): Promise<string> {
  const directory = join(root, '.mol4agent', 'captures')
  await mkdir(directory, { recursive: true })
  const file = join(directory, `mol4agent-${Date.now()}-${captureId.slice(0, 8)}.png`)
  await writeFile(file, png)
  return file
}

function decodePng(data: string): Uint8Array {
  const compact = data.replace(/\s+/gu, '')
  if (compact.length === 0 || compact.length % 4 !== 0) throw new Error('capture data is not valid base64')
  const png = base64ToBytes(compact)
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (png.byteLength < signature.length || signature.some((value, index) => png[index] !== value)) {
    throw new Error('capture data is not a PNG')
  }
  return png
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (raw === undefined || raw === '') return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 ? value : fallback
}
