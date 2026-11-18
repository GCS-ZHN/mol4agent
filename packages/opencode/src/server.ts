/**
 * OpenCode 2 server part for mol4agent: registers the `mol_*` tools and the
 * `mol4agent` RPC that the GUI panel talks to. Paths, bytes, and the scene log
 * live here; core receives only `{ data, format, label }` plus JSON commands.
 *
 * Scenes are bucketed per session (`store` is process-wide on `globalThis`), so
 * one session's `mol_open`/style/capture never touches another session's panel.
 * Scene tools accept an optional `tab` (the absolute path `mol_open` returns).
 *
 * @module @gcszhn/mol4agent-opencode
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Plugin } from '@opencode/plugin'
import { Mol4AgentError, type MolCommand, type StructureSelector } from '@gcszhn/mol4agent-core/protocol'
import { SOURCE_DATABASES, resolveSource, type ResolvedSource, type SourceDatabase } from '@gcszhn/mol4agent-core/sources'
import { base64ToBytes } from './base64.ts'
import { CaptureHub } from './capture.ts'
import { FetchTargetError, downloadMoleculeSource, resolveFetchTarget } from './fetch.ts'
import { baseNameOf } from './formats.ts'
import { findInterfaceResidues } from './interface.ts'
import { resolveMoleculeFile, type ResolvedMoleculeFile } from './paths.ts'
import { Mol4Agent } from './rpc.ts'
import { SceneStore, type SceneSnapshot } from './scene.ts'
import { normalizeSelector } from './selector.ts'
import {
  MEASUREMENT_KINDS,
  SELECTOR_SCHEMA,
  STYLE_SCHEMA,
  assertColorParams,
  describeFile,
  describeSelector,
  describeStyle,
  formatInterface,
  styleOf,
  summarizeSafely,
  tabOf,
  validateSelectorAgainst,
} from './tools.ts'

const MAX_FILE_BYTES = 64 * 1024 * 1024
const FETCH_TIMEOUT_MS = 30_000
const DEFAULT_CAPTURE_WIDTH = 1024
const DEFAULT_CAPTURE_HEIGHT = 768
const CAPTURE_TIMEOUT_MS = readPositiveInt('MOL4AGENT_CAPTURE_TIMEOUT_MS', 45_000)

/**
 * Process-wide scene log and capture hub.
 *
 * OpenCode loads a plugin once per location (and re-evaluates the module per
 * location), so neither closure state nor module state is shared across
 * locations. The scene log itself is bucketed per session inside `SceneStore`;
 * `globalThis` only makes the container shared across locations in this
 * process, which is the scope the RPC event broadcast reaches.
 *
 * The key is stable and carries no schema version: the package is unreleased.
 * A dev hot reload that changes the store shape can keep the previous instance
 * (`??=`), so restart the server after such a change.
 */
const globalKey = '__mol4agent_opencode_state__'
const g = globalThis as unknown as Record<string, unknown>
const store = (g[`${globalKey}store`] ??= new SceneStore()) as SceneStore
const captures = (g[`${globalKey}captures`] ??= new CaptureHub()) as CaptureHub

export default Plugin.define({
  id: 'mol4agent-opencode',
  async setup(ctx) {
    const sessionDirectory = async (sessionID: string): Promise<string> => {
      try {
        const session = await ctx.session.get({ sessionID })
        if (session.location?.directory) return session.location.directory
      } catch (reason) {
        console.warn('[mol4agent] could not read the session directory', reason)
      }
      // Never fall back to the server's process cwd: that can silently read a
      // same-named file from the wrong workspace.
      throw new Error(
        `could not resolve the workspace directory for session ${sessionID}; `
        + 'open a structure from an active session or pass an absolute server-side path',
      )
    }

    const requireScene = (sessionID: string, action: string, tab: string | undefined): SceneSnapshot => {
      const scene = store.snapshot(sessionID, tab ?? null)
      if (scene === null) {
        throw new Error(tab === undefined
          ? `open a structure with mol_open before trying to ${action} it`
          : `no open structure for tab "${tab}"; call mol_open first or pass the tab id it returned`)
      }
      return scene
    }

    const recordOf = (scene: SceneSnapshot) => store.recordBySceneId(scene.sceneId)

    // ---- RPC (GUI <-> server) ---------------------------------------------

    const registration = await ctx.rpc.register(Mol4Agent, {
      async listScenes(input) {
        const { sessionID } = input as { sessionID?: string }
        return store.list(sessionID ?? '')
      },
      async fetchScene(input) {
        const { sceneId, sessionID } = input as { sceneId: string; sessionID?: string }
        const data = store.fetch(sceneId, sessionID)
        if (data === undefined) throw new Error(`structure scene ${sceneId} is no longer available`)
        return data
      },
      async openPath(input) {
        const { path, cwd, base, sessionID } = input as {
          path: string
          cwd?: string
          base?: string
          sessionID?: string
        }
        try {
          // Resolution belongs to the server that owns the session. The GUI may
          // be a desktop window on another machine (or OS), so its `cwd` is only
          // a fallback for callers that have no session.
          const root = sessionID === undefined || sessionID === ''
            ? (cwd ?? process.cwd())
            : await sessionDirectory(sessionID)
          const file = await resolveMoleculeFile(root, path, MAX_FILE_BYTES, new AbortController().signal, base)
          const scene = store.open(sessionID ?? '', {
            path: file.absolutePath,
            label: file.label,
            format: file.format,
            bytes: file.bytes,
            commands: [{ op: 'represent', style: { type: 'cartoon', color: 'chain-id' } }],
          })
          emitScene(sessionID ?? '', scene.path)
          return { ok: true, path: file.absolutePath, tab: scene.path }
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
        // Only save while the capture is still pending; a late delivery after a
        // timeout must not write into the server's cwd.
        const saveDir = captures.saveDirOf(captureId)
        if (saveDir === undefined) return { ok: false, path: '' }
        try {
          const png = decodePng(data)
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
      async pendingCaptures(input) {
        const { sessionID } = input as { sessionID?: string }
        return {
          captures: captures.pendingForSession(sessionID ?? '').map(capture => ({
            captureId: capture.captureId,
            sceneId: capture.scene.sceneId,
            path: capture.scene.path,
            label: capture.scene.label,
            width: capture.width,
            height: capture.height,
            transparent: capture.transparent,
          })),
        }
      },
    })

    const emitScene = (sessionID: string, openedPath?: string): void => {
      void registration.events.emit('scene', {
        sessionID,
        ...(openedPath === undefined ? {} : { path: openedPath, open: true }),
      })
    }
    const emitCapture = (capture: {
      sessionID: string
      captureId: string
      sceneId: string
      path: string
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
        name: 'mol_fetch',
        description:
          'Download a molecular structure from an online database and save it to a path. Use it when '
          + 'the user names a database entry instead of a local file: PDB ids (1crn), AlphaFold UniProt '
          + 'accessions (P00533), PubChem CIDs or names (2244, aspirin), or ChEMBL ids (CHEMBL25). '
          + 'Returns the saved path and a structure summary; use mol_open with that path to display it.',
        input: {
          type: 'object',
          properties: {
            entry_id: {
              type: 'string',
              minLength: 1,
              description: 'Entry id or compound name for source_db. rcsb-pdb/rcsb-cif/rcsb-bcif: '
                + '4-character PDB id (1crn); alphafold: UniProt accession (P00533); '
                + 'pubchem: CID (2244) or compound name (aspirin); chembl: ChEMBL id (CHEMBL25).',
            },
            target_path: {
              type: 'string',
              minLength: 1,
              description: 'Destination path on the session\'s server, absolute or relative to the '
                + 'session working directory. A directory or a trailing slash appends the source file '
                + 'name; a path without a suffix gets one.',
            },
            source_db: {
              enum: SOURCE_DATABASES,
              description: 'Source database. Defaults to rcsb-pdb.',
            },
          },
          required: ['entry_id', 'target_path'],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const args = input as { entry_id: string; target_path: string; source_db?: string }
          let source: ResolvedSource
          try {
            source = resolveSource({ entryId: args.entry_id, sourceDb: args.source_db as SourceDatabase | undefined })
          } catch (error) {
            if (error instanceof Mol4AgentError) throw new Error(error.message)
            throw error
          }
          const cwd = await sessionDirectory(context.sessionID)
          let targetPath: string
          try {
            targetPath = await resolveFetchTarget(cwd, args.target_path, source)
          } catch (error) {
            if (error instanceof FetchTargetError) throw new Error(error.message)
            throw error
          }
          const download = await downloadMoleculeSource({
            source,
            targetPath,
            maxBytes: MAX_FILE_BYTES,
            timeoutMs: FETCH_TIMEOUT_MS,
            signal: context.signal,
          })
          const file: ResolvedMoleculeFile = {
            absolutePath: targetPath,
            format: source.format,
            label: baseNameOf(targetPath),
            bytes: download.bytes,
          }
          return {
            content:
              `Downloaded ${source.description} from ${download.url}\n`
              + `saved: ${targetPath} (${download.bytes.byteLength} bytes)\n\n`
              + describeFile(file)
              + `\n\nUse mol_open with path "${targetPath}" to display it.`,
          }
        },
      })

      editor.add({
        name: 'mol_open',
        description:
          'Open a molecular structure in the mol4agent 3D viewer (in the side panel) and make it the '
          + 'active scene. Optionally set the representation/color and highlight a selection. Returns the '
          + 'tab id (absolute path) for the scene tools. The viewer updates when later '
          + 'mol_style/mol_select/mol_focus/mol_measure calls run.',
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
            colorParams?: { value?: string | number }
            select?: unknown
            focus?: boolean
          }
          const cwd = await sessionDirectory(context.sessionID)
          if (args.colorParams !== undefined) assertColorParams(args.colorParams)
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
          const scene = store.open(context.sessionID, {
            path: file.absolutePath,
            label: file.label,
            format: file.format,
            bytes: file.bytes,
            commands,
          })
          emitScene(context.sessionID, scene.path)
          return {
            content:
              `${describeFile(file)}\n\nOpened ${file.label} in the mol4agent viewer (tab: ${scene.path}). `
              + 'Use mol_style, mol_select, mol_focus, mol_measure, or mol_capture with this tab to operate it.',
          }
        },
      })

      editor.add({
        name: 'mol_style',
        description:
          'Change the representation or color theme of an open structure. Replaces the current '
          + 'representations by default; pass replace:false to keep them and overlay the new style. '
          + 'target narrows only the part the new representation covers. Pass `tab` '
          + '(the path mol_open returned) to target a specific open structure; defaults to the active one.',
        input: {
          type: 'object',
          properties: {
            ...STYLE_SCHEMA,
            target: SELECTOR_SCHEMA,
            replace: { type: 'boolean' },
            tab: { type: 'string' },
          },
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const args = input as {
            type?: string
            color?: string
            colorParams?: { value?: string | number }
            target?: unknown
            replace?: boolean
            tab?: string
          }
          const tab = tabOf(args)
          const scene = requireScene(context.sessionID, 'style', tab)
          if (args.colorParams !== undefined) assertColorParams(args.colorParams)
          const target = args.target === undefined ? undefined : normalizeSelector(args.target)
          const record = recordOf(scene)
          if (target !== undefined && record !== undefined) {
            validateSelectorAgainst(record.summary, record.bytes, record.format, target)
          }
          store.push(context.sessionID, tab ?? null, {
            op: 'represent',
            style: styleOf({ type: args.type as never, color: args.color as never, colorParams: args.colorParams }),
            ...(target === undefined ? {} : { target }),
            ...(args.replace === undefined ? {} : { replace: args.replace }),
          })
          emitScene(context.sessionID)
          return {
            content: describeStyle({
              type: args.type as never,
              color: args.color as never,
              colorParams: args.colorParams,
              target,
              replace: args.replace,
            }),
          }
        },
      })

      editor.add({
        name: 'mol_select',
        description:
          'Select, highlight, or focus part of an open structure. Pass `tab` to target a specific open '
          + 'structure; defaults to the active one.',
        input: {
          type: 'object',
          properties: {
            target: SELECTOR_SCHEMA,
            mode: { enum: ['select', 'highlight'] },
            focus: { type: 'boolean' },
            tab: { type: 'string' },
          },
          required: ['target'],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const args = input as { target: unknown; mode?: 'select' | 'highlight'; focus?: boolean; tab?: string }
          const tab = tabOf(args)
          const scene = requireScene(context.sessionID, 'select', tab)
          const target = normalizeSelector(args.target)
          const record = recordOf(scene)
          if (record !== undefined) validateSelectorAgainst(record.summary, record.bytes, record.format, target)
          store.push(context.sessionID, tab ?? null, {
            op: 'select',
            target,
            mode: args.mode ?? 'select',
            ...(args.focus === true ? { focus: true } : {}),
          })
          emitScene(context.sessionID)
          return {
            content:
              `${args.mode === 'highlight' ? 'Highlighted' : 'Selected'} ${describeSelector(target)}`
              + `${args.focus === true ? ' and focused the camera' : ''}.`,
          }
        },
      })

      editor.add({
        name: 'mol_focus',
        description:
          'Move the camera to a selection, or to the whole structure when target is omitted. Pass `tab` to '
          + 'target a specific open structure; defaults to the active one.',
        input: {
          type: 'object',
          properties: { target: SELECTOR_SCHEMA, tab: { type: 'string' } },
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const args = input as { target?: unknown; tab?: string }
          const tab = tabOf(args)
          const scene = requireScene(context.sessionID, 'focus', tab)
          const target = args.target === undefined ? undefined : normalizeSelector(args.target)
          if (target !== undefined) {
            const record = recordOf(scene)
            if (record !== undefined) validateSelectorAgainst(record.summary, record.bytes, record.format, target)
          }
          store.push(context.sessionID, tab ?? null, { op: 'focus', ...(target === undefined ? {} : { target }) })
          emitScene(context.sessionID)
          return {
            content: target === undefined ? 'Focused the whole structure.' : `Focused ${describeSelector(target)}.`,
          }
        },
      })

      editor.add({
        name: 'mol_measure',
        description:
          'Add a distance (exactly 2 targets), angle (exactly 3 targets), or dihedral (exactly 4 targets) '
          + 'measurement between atomic selections in an open viewer. Pass `tab` to target a specific open '
          + 'structure; defaults to the active one.',
        input: {
          type: 'object',
          properties: {
            kind: { enum: ['distance', 'angle', 'dihedral'] },
            targets: { type: 'array', items: SELECTOR_SCHEMA, minItems: 2, maxItems: 4 },
            tab: { type: 'string' },
          },
          required: ['kind', 'targets'],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const args = input as { kind: 'distance' | 'angle' | 'dihedral'; targets: unknown[]; tab?: string }
          const tab = tabOf(args)
          const scene = requireScene(context.sessionID, 'measure', tab)
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
          const record = recordOf(scene)
          if (record !== undefined) {
            for (const target of targets) validateSelectorAgainst(record.summary, record.bytes, record.format, target)
          }
          store.push(context.sessionID, tab ?? null, { op: 'measure', kind: args.kind, targets })
          emitScene(context.sessionID)
          return { content: `Added a ${args.kind} measurement.` }
        },
      })

      editor.add({
        name: 'mol_capture',
        description:
          'Capture an open molecular viewer viewport as a PNG and save it under `.mol4agent/captures/`. '
          + 'The viewer tab must be open. Pass `tab` to capture a specific open structure; defaults to the '
          + 'active one. Use it to visually verify a view or produce a figure.',
        input: {
          type: 'object',
          properties: {
            width: { type: 'integer', minimum: 64, maximum: 4096 },
            height: { type: 'integer', minimum: 64, maximum: 4096 },
            transparent: { type: 'boolean' },
            tab: { type: 'string' },
          },
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const args = input as { width?: number; height?: number; transparent?: boolean; tab?: string }
          const tab = tabOf(args)
          const scene = requireScene(context.sessionID, 'capture', tab)
          const width = args.width ?? DEFAULT_CAPTURE_WIDTH
          const height = args.height ?? DEFAULT_CAPTURE_HEIGHT
          const cwd = await sessionDirectory(context.sessionID)
          const pending = captures.enqueue({
            sessionID: context.sessionID,
            scene,
            width,
            height,
            transparent: args.transparent === true,
            saveDir: cwd,
          })
          emitCapture({
            sessionID: context.sessionID,
            captureId: pending.captureId,
            sceneId: scene.sceneId,
            path: scene.path,
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
