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
import {
  ALIGNMENT_METHODS,
  INSPECT_DETAILS,
  Mol4AgentError,
  isAlignmentMethod,
  isInspectDetail,
  isStructureId,
  type AlignmentMethod,
  type InspectRequest,
  type MolCommand,
  type StructureSelector,
  type TmScoreRequest,
} from '@gcszhn/mol4agent-core/protocol'
import { SOURCE_DATABASES, resolveSource, type ResolvedSource, type SourceDatabase } from '@gcszhn/mol4agent-core/sources'
import { AlignHub, alignAnswerOf } from './align.ts'
import { base64ToBytes } from './base64.ts'
import { CaptureHub } from './capture.ts'
import { FetchTargetError, downloadMoleculeSource, resolveFetchTarget } from './fetch.ts'
import { formatInspectResult } from './format-inspect.ts'
import { baseNameOf } from './formats.ts'
import { findInterfaceResidues } from './interface.ts'
import { InspectHub, TmScoreHub, inspectAnswerOf, tmScoreAnswerOf } from './inspect.ts'
import { resolveMoleculeFile, type ResolvedMoleculeFile } from './paths.ts'
import { Mol4Agent } from './rpc.ts'
import { SceneStore, activeStructures, nextStructureId, type SceneRecord, type SceneSnapshot } from './scene.ts'
import { normalizeInspectTarget, normalizeSelector } from './selector.ts'
import {
  INSPECT_TARGET_SCHEMA,
  MEASUREMENT_KINDS,
  SELECTOR_DESCRIPTION,
  SELECTOR_SCHEMA,
  STYLE_SCHEMA,
  assertColorParams,
  describeFile,
  describeSelector,
  describeStyle,
  formatAlignment,
  formatInterface,
  formatTmScore,
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
const INSPECT_TIMEOUT_MS = readPositiveInt('MOL4AGENT_INSPECT_TIMEOUT_MS', 20_000)
const ALIGN_TIMEOUT_MS = readPositiveInt('MOL4AGENT_ALIGN_TIMEOUT_MS', 45_000)
const TM_SCORE_TIMEOUT_MS = readPositiveInt('MOL4AGENT_TMSCORE_TIMEOUT_MS', 30_000)

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
const inspections = (g[`${globalKey}inspections`] ??= new InspectHub()) as InspectHub
const tmScores = (g[`${globalKey}tmScores`] ??= new TmScoreHub()) as TmScoreHub
const aligns = (g[`${globalKey}aligns`] ??= new AlignHub()) as AlignHub

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

    const validateTarget = (scene: SceneSnapshot, selector: StructureSelector): void => {
      const record = recordOf(scene)
      if (record === undefined) return
      const active = activeStructures(scene)
      const activeIds = new Set(active.map(structure => structure.id))
      if (selector.structureId !== undefined) {
        if (!activeIds.has(selector.structureId)) {
          throw new Error(
            `no active structure with id "${selector.structureId}" in this scene; available: `
            + active.map(candidate => candidate.id).join(', '),
          )
        }
        const structure = record.structures.find(candidate => candidate.id === selector.structureId)
        if (structure !== undefined) {
          validateSelectorAgainst(structure.summary, structure.bytes, structure.format, selector)
        }
        return
      }
      // An unscoped selector applies to every active structure, so it is valid
      // when it matches any one of them (e.g. chain B only exists in the second).
      let firstError: unknown
      for (const source of record.structures) {
        if (!activeIds.has(source.id)) continue
        try {
          validateSelectorAgainst(source.summary, source.bytes, source.format, selector)
          return
        } catch (reason) {
          firstError ??= reason
        }
      }
      if (firstError !== undefined) throw firstError
    }

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
      async fetchStructure(input) {
        const { sceneId, structureId, sessionID } = input as {
          sceneId: string
          structureId: string
          sessionID?: string
        }
        const data = store.fetchStructure(sceneId, structureId, sessionID)
        if (data === undefined) {
          throw new Error(`structure ${structureId} of scene ${sceneId} is no longer available`)
        }
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
      async deliverInspect(input) {
        const { inspectId } = input as { inspectId: string }
        // Treat the browser's answer as untrusted JSON; a malformed payload must
        // not reach the formatter.
        const answer = inspectAnswerOf(input)
        if (answer === undefined) return { ok: false }
        return { ok: inspections.deliver(inspectId, answer) }
      },
      async pendingInspections(input) {
        const { sessionID } = input as { sessionID?: string }
        return {
          inspections: inspections.pendingForSession(sessionID ?? '').map(inspect => ({
            inspectId: inspect.queryId,
            sceneId: inspect.scene.sceneId,
            path: inspect.scene.path,
            label: inspect.scene.label,
            ...(inspect.request.target === undefined ? {} : { target: inspect.request.target }),
            ...(inspect.request.detail === undefined ? {} : { detail: inspect.request.detail }),
            ...(inspect.request.limit === undefined ? {} : { limit: inspect.request.limit }),
          })),
        }
      },
      async deliverAlign(input) {
        const { sceneId, commandIndex } = input as { sceneId: string; commandIndex: number }
        const answer = alignAnswerOf(input)
        if (answer === undefined) return { ok: false }
        return { ok: aligns.deliver(sceneId, commandIndex, answer) }
      },
      async deliverTmScore(input) {
        const { tmScoreId } = input as { tmScoreId: string }
        const answer = tmScoreAnswerOf(input)
        if (answer === undefined) return { ok: false }
        return { ok: tmScores.deliver(tmScoreId, answer) }
      },
      async pendingTmScores(input) {
        const { sessionID } = input as { sessionID?: string }
        return {
          queries: tmScores.pendingForSession(sessionID ?? '').map(query => ({
            tmScoreId: query.queryId,
            sceneId: query.scene.sceneId,
            path: query.scene.path,
            label: query.scene.label,
            reference: query.request.reference,
            target: query.request.target,
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
    const emitInspect = (inspect: {
      sessionID: string
      inspectId: string
      sceneId: string
      path: string
      label: string
      request: InspectRequest
    }): void => {
      void registration.events.emit('inspect', {
        sessionID: inspect.sessionID,
        inspectId: inspect.inspectId,
        sceneId: inspect.sceneId,
        path: inspect.path,
        label: inspect.label,
        ...(inspect.request.target === undefined ? {} : { target: inspect.request.target }),
        ...(inspect.request.detail === undefined ? {} : { detail: inspect.request.detail }),
        ...(inspect.request.limit === undefined ? {} : { limit: inspect.request.limit }),
      })
    }

    const emitTmScore = (query: {
      sessionID: string
      tmScoreId: string
      sceneId: string
      path: string
      label: string
      request: TmScoreRequest
    }): void => {
      void registration.events.emit('tmScore', {
        sessionID: query.sessionID,
        tmScoreId: query.tmScoreId,
        sceneId: query.sceneId,
        path: query.path,
        label: query.label,
        reference: query.request.reference,
        target: query.request.target,
      })
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
        name: 'mol_inspect',
        description:
          'Read what the molecular viewer currently shows: residue/atom identity, coordinates, '
          + 'per-component counts (waters, ligands, amino-acid types), and how the target is drawn '
          + '(representation type, colour theme, size theme, resolved colour). '
          + 'Answers come from the live Mol* page, so they include changes a human made by clicking or '
          + 'through the Mol* panel. Use it instead of parsing the structure file. Read-only: it changes nothing.',
        input: {
          type: 'object',
          properties: {
            tab: {
              type: 'string',
              description:
                'Pass the path mol_open returned to inspect a specific open structure; defaults to the active one.',
            },
            target: {
              ...INSPECT_TARGET_SCHEMA,
              description:
                'What to inspect. Omit for the whole structure. Accepts any selector, plus '
                + '{"kind":"selection"} for what is currently selected and {"kind":"focus"} for the last clicked location.',
            },
            detail: {
              enum: INSPECT_DETAILS,
              description:
                'summary = totals, per-component counts, and styles; residues = also residue rows; '
                + 'atoms = residue rows with per-atom coordinates. Defaults to summary.',
            },
            limit: {
              type: 'integer',
              minimum: 1,
              description: 'Maximum residue rows to return. Defaults to 200; totals and counts are never truncated.',
            },
          },
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const args = input as { tab?: string; target?: unknown; detail?: unknown; limit?: unknown }
          const tab = tabOf(args)
          const scene = requireScene(context.sessionID, 'inspect', tab)
          if (args.detail !== undefined && !isInspectDetail(args.detail)) {
            throw new Error(`detail must be one of ${INSPECT_DETAILS.join(', ')}`)
          }
          if (args.limit !== undefined && (!Number.isInteger(args.limit) || (args.limit as number) <= 0)) {
            throw new Error('limit must be a positive integer')
          }
          const target = args.target === undefined ? undefined : normalizeInspectTarget(args.target)
          if (target !== undefined && target.kind !== 'selection' && target.kind !== 'focus') {
            validateTarget(scene, target)
          }
          const request: InspectRequest = {
            ...(target === undefined ? {} : { target }),
            ...(isInspectDetail(args.detail) ? { detail: args.detail } : {}),
            ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
          }
          const pending = inspections.enqueue({
            sessionID: context.sessionID,
            scene,
            request,
          })
          emitInspect({
            sessionID: context.sessionID,
            inspectId: pending.queryId,
            sceneId: scene.sceneId,
            path: scene.path,
            label: scene.label,
            request,
          })
          const answer = await inspections.wait(pending.queryId, INSPECT_TIMEOUT_MS, context.signal)
          if (!answer.ok) return { content: `Could not inspect ${scene.label}: ${answer.message}` }
          return { content: formatInspectResult(answer.result) }
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
              + 'Primary structure id: "structure". Use mol_style, mol_select, mol_focus, mol_measure, '
              + 'mol_inspect, or mol_capture with this tab to operate it.',
          }
        },
      })

      editor.add({
        name: 'mol_add_structure',
        description:
          'Add another structure to an open viewer tab without replacing the current one. The structure '
          + 'gets a stable id for selectors, mol_align, and mol_tmscore. Returns the id and a summary.',
        input: {
          type: 'object',
          properties: {
            path: { type: 'string', minLength: 1 },
            id: {
              type: 'string',
              pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$',
              description: 'Optional structure id. Defaults to the next "structure-N".',
            },
            ...STYLE_SCHEMA,
            focus: { type: 'boolean', description: 'Focus the camera on the newly added structure.' },
            tab: { type: 'string' },
          },
          required: ['path'],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const args = input as {
            path: string
            id?: string
            type?: string
            color?: string
            colorParams?: { value?: string | number }
            focus?: boolean
            tab?: string
          }
          const tab = tabOf(args)
          const scene = requireScene(context.sessionID, 'add a structure to', tab)
          if (args.colorParams !== undefined) assertColorParams(args.colorParams)
          const file = await resolveMoleculeFile(
            await sessionDirectory(context.sessionID),
            args.path,
            MAX_FILE_BYTES,
            context.signal,
          )
          const record = recordOf(scene)
          const id = args.id ?? nextStructureId(record?.structures ?? [])
          if (!isStructureId(id)) {
            throw new Error(
              'structure id must start with a letter or digit and contain only letters, digits, ".", "_", or "-"',
            )
          }
          if (record?.structures.some(structure => structure.id === id) === true) {
            throw new Error(`structure id "${id}" is already used in this scene; choose another id`)
          }
          let next = store.addStructure(context.sessionID, tab ?? null, {
            id,
            path: file.absolutePath,
            label: file.label,
            format: file.format,
            bytes: file.bytes,
          })
          if (next === null) throw new Error('open a structure with mol_open before adding another')
          if (args.type !== undefined || args.color !== undefined || args.colorParams !== undefined) {
            next = store.push(context.sessionID, tab ?? null, {
              op: 'represent',
              style: styleOf({ type: args.type as never, color: args.color as never, colorParams: args.colorParams }),
              target: { kind: 'all', structureId: id },
            }) ?? next
          }
          if (args.focus === true) {
            next = store.push(context.sessionID, tab ?? null, {
              op: 'focus',
              target: { kind: 'all', structureId: id },
            }) ?? next
          }
          emitScene(context.sessionID)
          return {
            content:
              `${describeFile(file)}\n\nAdded to ${scene.label} as structure id "${id}". `
              + `Use {"kind":"chain","chain":"A","structureId":"${id}"} in selectors and pass `
              + `reference/target "${id}" to mol_align or mol_tmscore.`,
          }
        },
      })

      editor.add({
        name: 'mol_list_structures',
        description: 'List the structures loaded in an open viewer tab, with their ids, formats, and counts. '
          + 'Use the ids in selector structureId, mol_align, mol_tmscore, or mol_remove_structure.',
        input: {
          type: 'object',
          properties: { tab: { type: 'string' } },
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const scene = requireScene(context.sessionID, 'list structures in', tabOf(input))
          const record = recordOf(scene)
          const structures = record === undefined ? [] : activeStructures(scene)
          const lines = [`<structures tab="${scene.path}">`]
          for (const structure of structures) {
            const source = record?.structures.find(candidate => candidate.id === structure.id)
            const summary = source?.summary
            lines.push(
              `- ${structure.id}: ${structure.label} (${structure.format})`
              + `${summary === undefined
                ? ''
                : `, ${summary.atomCount} atoms, ${summary.residueCount} residues`}`
              + `${structure.id === 'structure' ? ' [primary]' : ''}`,
            )
          }
          if (structures.length === 0) lines.push('- none')
          lines.push('</structures>')
          return { content: lines.join('\n') }
        },
      })

      editor.add({
        name: 'mol_remove_structure',
        description: 'Remove one structure from an open viewer tab without closing the tab. '
          + 'Use the primary id "structure" or an id from mol_add_structure/mol_list_structures.',
        input: {
          type: 'object',
          properties: { structureId: { type: 'string', minLength: 1 }, tab: { type: 'string' } },
          required: ['structureId'],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const args = input as { structureId: string; tab?: string }
          const tab = tabOf(args)
          const scene = requireScene(context.sessionID, 'remove a structure from', tab)
          if (!activeStructures(scene).some(structure => structure.id === args.structureId)) {
            throw new Error(`no active structure with id "${args.structureId}" in this tab`)
          }
          store.push(context.sessionID, tab ?? null, {
            op: 'remove-structure',
            structureId: args.structureId,
          })
          emitScene(context.sessionID)
          return { content: `Removed structure "${args.structureId}".` }
        },
      })

      editor.add({
        name: 'mol_align',
        description:
          'Superpose one loaded structure onto another. Both structures must be in the same viewer tab; '
          + 'add the second one with mol_add_structure. Returns RMSD and TM-score (default tm-align) or '
          + 'RMSD for sequence alignment. Optionally restrict the alignment to one auth chain per structure.',
        input: {
          type: 'object',
          properties: {
            reference: { type: 'string', minLength: 1, description: 'Reference structure id (stays fixed).' },
            target: { type: 'string', minLength: 1, description: 'Target structure id (is moved).' },
            method: { enum: ALIGNMENT_METHODS },
            referenceChain: { type: 'string', description: 'Optional reference auth chain id.' },
            targetChain: { type: 'string', description: 'Optional target auth chain id.' },
            tab: { type: 'string' },
          },
          required: ['reference', 'target'],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const args = input as {
            reference: string
            target: string
            method?: AlignmentMethod
            referenceChain?: string
            targetChain?: string
            tab?: string
          }
          const tab = tabOf(args)
          const scene = requireScene(context.sessionID, 'align structures in', tab)
          if (args.reference === args.target) throw new Error('reference and target must be different structures')
          const active = activeStructures(scene)
          for (const id of [args.reference, args.target]) {
            if (!active.some(structure => structure.id === id)) {
              throw new Error(
                `no active structure with id "${id}" in this tab; available: `
                + active.map(structure => structure.id).join(', '),
              )
            }
          }
          if (args.method !== undefined && !isAlignmentMethod(args.method)) {
            throw new Error(`method must be one of ${ALIGNMENT_METHODS.join(', ')}`)
          }
          const referenceChain = args.referenceChain?.trim()
          const targetChain = args.targetChain?.trim()
          const next = store.push(context.sessionID, tab ?? null, {
            op: 'align',
            reference: args.reference,
            target: args.target,
            ...(args.method === undefined ? {} : { method: args.method }),
            ...(referenceChain === undefined || referenceChain === '' ? {} : { referenceChain }),
            ...(targetChain === undefined || targetChain === '' ? {} : { targetChain }),
          })
          if (next === null) throw new Error('open a structure with mol_open before aligning')
          const commandIndex = next.commands.length - 1
          const waiting = aligns.wait(scene.sceneId, commandIndex, ALIGN_TIMEOUT_MS, context.signal)
          emitScene(context.sessionID)
          const answer = await waiting
          if (!answer.ok) return { content: `Could not align ${args.target} onto ${args.reference}: ${answer.message}` }
          return { content: formatAlignment(answer.result) }
        },
      })

      editor.add({
        name: 'mol_tmscore',
        description:
          'Compute TM-score and RMSD between two selections without moving either structure. Use '
          + 'structureId in the selectors when several structures are loaded. Read-only.',
        input: {
          type: 'object',
          properties: {
            reference: { ...SELECTOR_SCHEMA, description: `Reference selection. ${SELECTOR_DESCRIPTION}` },
            target: { ...SELECTOR_SCHEMA, description: `Target selection. ${SELECTOR_DESCRIPTION}` },
            tab: { type: 'string' },
          },
          required: ['reference', 'target'],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const args = input as { reference: unknown; target: unknown; tab?: string }
          const tab = tabOf(args)
          const scene = requireScene(context.sessionID, 'compute a TM-score in', tab)
          const reference = normalizeSelector(args.reference)
          const target = normalizeSelector(args.target)
          validateTarget(scene, reference)
          validateTarget(scene, target)
          const request: TmScoreRequest = { reference, target }
          const pending = tmScores.enqueue({ sessionID: context.sessionID, scene, request })
          emitTmScore({
            sessionID: context.sessionID,
            tmScoreId: pending.queryId,
            sceneId: scene.sceneId,
            path: scene.path,
            label: scene.label,
            request,
          })
          const answer = await tmScores.wait(pending.queryId, TM_SCORE_TIMEOUT_MS, context.signal)
          if (!answer.ok) return { content: `Could not compute a TM-score: ${answer.message}` }
          return { content: formatTmScore(answer.result) }
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
          if (target !== undefined) validateTarget(scene, target)
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
          validateTarget(scene, target)
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
          if (target !== undefined) validateTarget(scene, target)
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
          for (const target of targets) validateTarget(scene, target)
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
