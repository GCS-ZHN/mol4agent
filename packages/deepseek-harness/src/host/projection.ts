/**
 * The `mol4agent` session projection: tool calls become durable, replayable
 * scenes, one independent scene per document tab page.
 *
 * @module @gcszhn/mol4agent-deepseekharness/host/projection
 */
import { isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { InspectTarget, MolCommand, StyleSpec, StructureSelector } from '@gcszhn/mol4agent-core/protocol'
import { isAlignmentMethod, isInspectDetail, isStructureId, parseColor } from '@gcszhn/mol4agent-core/protocol'
import { baseNameOf, formatOfFile } from '../formats.ts'
import { normalizeSelector } from '../selector.ts'
import { canonicalTabPath } from '../tab-path.ts'
import {
  EMPTY_MOL_STATE,
  PROJECTION_KEY,
  nextStructureId,
  structuresOfScene,
  type MolPendingCapture,
  type MolPendingInspect,
  type MolSceneState,
  type MolSceneStructure,
  type MolSessionState,
} from '../state.ts'

const MEASUREMENT_KINDS = new Set(['chain', 'residue', 'residues', 'comp', 'schema'])

/** Inspect targets that name live viewer state instead of structure content. */
const LIVE_INSPECT_KINDS = new Set(['selection', 'focus'])

const stateSchema = z.custom<MolSessionState>(
  value => typeof value === 'object' && value !== null
    && 'revision' in value && 'tabs' in value && 'pending' in value
    && 'pendingAligns' in value && 'pendingTmScores' in value && 'inspecting' in value,
)

/** Build the projection unit the adapter registers on activation. */
export function molProjectionDefinition() {
  return {
    key: PROJECTION_KEY,
    stateSchema,
    init: header => ({ ...EMPTY_MOL_STATE, ...(header.cwd === undefined ? {} : { cwd: header.cwd }) }),
    apply: fold,
    wire: {
      viewSchema: stateSchema,
      view: state => state,
      summary: false,
    },
    stateVersion: 6,
  } satisfies ProjectionDefinition<typeof PROJECTION_KEY, MolSessionState>
}

function fold(state: MolSessionState, event: SessionEvent): MolSessionState {
  if (event.type === 'tool/call') {
    return foldToolCall(state, String(event.data.name), String(event.data.callId), event.data.arguments)
  }
  if (event.type === 'tool/result') {
    const callId = String(event.data.message.toolCallId)
    if (!(callId in state.pending) && !(callId in state.pendingAligns)
      && !(callId in state.pendingTmScores) && !(callId in state.inspecting)) return state
    const pending = { ...state.pending }
    delete pending[callId]
    const pendingAligns = { ...state.pendingAligns }
    delete pendingAligns[callId]
    const pendingTmScores = { ...state.pendingTmScores }
    delete pendingTmScores[callId]
    const inspecting = { ...state.inspecting }
    delete inspecting[callId]
    return { ...state, revision: state.revision + 1, pending, pendingAligns, pendingTmScores, inspecting }
  }
  return state
}

function foldToolCall(state: MolSessionState, name: string, callId: string, argumentsJson: string): MolSessionState {
  if (!name.startsWith('mol_')) return state
  let args: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(argumentsJson)
    if (typeof parsed !== 'object' || parsed === null) return state
    args = parsed as Record<string, unknown>
  } catch {
    return state
  }

  switch (name) {
    case 'mol_open':
      return openScene(state, args, callId)

    case 'mol_style': {
      const tab = tabOf(state, args)
      if (tab === undefined) return state
      const target = args.target === undefined ? undefined : selectorOf(args.target)
      if (args.target !== undefined && target === undefined) return state
      const style = styleOf(args)
      if (style === undefined) return state
      const command: MolCommand = {
        op: 'represent',
        style,
        ...(target === undefined ? {} : { target }),
        ...(typeof args.replace === 'boolean' ? { replace: args.replace } : {}),
      }
      return withCommands(state, tab.path, [...tab.commands, command])
    }

    case 'mol_focus': {
      const tab = tabOf(state, args)
      if (tab === undefined) return state
      const target = args.target === undefined ? undefined : selectorOf(args.target)
      if (args.target !== undefined && target === undefined) return state
      const command: MolCommand = { op: 'focus', ...(target === undefined ? {} : { target }) }
      return withCommands(state, tab.path, [...tab.commands, command])
    }

    case 'mol_select': {
      const tab = tabOf(state, args)
      if (tab === undefined) return state
      const target = selectorOf(args.target)
      if (target === undefined) return state
      const command: MolCommand = {
        op: 'select',
        target,
        mode: args.mode === 'highlight' ? 'highlight' : 'select',
        ...(args.focus === true ? { focus: true } : {}),
      }
      return withCommands(state, tab.path, [...tab.commands, command])
    }

    case 'mol_add_structure': {
      const tab = tabOf(state, args)
      if (tab === undefined) return state
      const requestedPath = typeof args.path === 'string' ? args.path : undefined
      if (requestedPath === undefined) return state
      const path = canonicalTabPath(
        isAbsolute(requestedPath) ? requestedPath : state.cwd === undefined ? requestedPath : resolve(state.cwd, requestedPath),
      )
      const format = formatOfFile(path)
      if (format === undefined) return state
      const structures = structuresOfScene(tab)
      const id = args.id === undefined ? nextStructureId(structures) : args.id
      if (!isStructureId(id)) return state
      if (structures.some(structure => structure.id === id)) return state
      const entry = { id, path, format, label: baseNameOf(path), callId }
      const commands: MolCommand[] = [...tab.commands]
      // addStructure already installs the default representation. Only append a
      // style command when the agent asked for one explicitly.
      if (args.type !== undefined || args.color !== undefined || args.colorParams !== undefined) {
        const style = styleOf(args)
        if (style === undefined) return state
        commands.push({
          op: 'represent',
          style,
          target: { kind: 'all', structureId: id },
        })
      }
      if (args.focus === true) {
        commands.push({ op: 'focus', target: { kind: 'all', structureId: id } })
      }
      return {
        ...state,
        revision: state.revision + 1,
        tabs: {
          ...state.tabs,
          [tab.path]: { ...tab, structures: [...structures, entry], commands },
        },
        active: tab.path,
      }
    }

    case 'mol_align': {
      const tab = tabOf(state, args)
      if (tab === undefined) return state
      const reference = args.reference
      const target = args.target
      if (!isStructureId(reference) || !isStructureId(target) || reference === target) return state
      const structures = activeStructures(tab)
      if (!structures.some(structure => structure.id === reference)) return state
      if (!structures.some(structure => structure.id === target)) return state
      if (args.method !== undefined && !isAlignmentMethod(args.method)) return state
      if (args.referenceChain !== undefined && typeof args.referenceChain !== 'string') return state
      if (args.targetChain !== undefined && typeof args.targetChain !== 'string') return state
      const command: MolCommand = {
        op: 'align',
        reference,
        target,
        ...(args.method === undefined ? {} : { method: args.method }),
        ...(args.referenceChain === undefined ? {} : { referenceChain: String(args.referenceChain) }),
        ...(args.targetChain === undefined ? {} : { targetChain: String(args.targetChain) }),
      }
      return withAlignment(state, tab, command, callId)
    }

    case 'mol_remove_structure': {
      const tab = tabOf(state, args)
      if (tab === undefined) return state
      const structureId = args.structureId
      if (!isStructureId(structureId)) return state
      if (!activeStructures(tab).some(structure => structure.id === structureId)) return state
      return withCommands(state, tab.path, [...tab.commands, { op: 'remove-structure', structureId }])
    }

    case 'mol_measure': {
      const tab = tabOf(state, args)
      if (tab === undefined) return state
      const kind = args.kind
      if (kind !== 'distance' && kind !== 'angle' && kind !== 'dihedral') return state
      const rawTargets = Array.isArray(args.targets) ? args.targets : []
      const targets: StructureSelector[] = []
      for (const raw of rawTargets) {
        const target = selectorOf(raw)
        if (target !== undefined && MEASUREMENT_KINDS.has(target.kind)) targets.push(target)
      }
      const needed = kind === 'distance' ? 2 : kind === 'angle' ? 3 : 4
      if (targets.length !== needed) return state
      const command: MolCommand = { op: 'measure', kind, targets }
      return withCommands(state, tab.path, [...tab.commands, command])
    }

    case 'mol_tmscore': {
      const tab = tabOf(state, args)
      if (tab === undefined) return state
      const reference = selectorOf(args.reference)
      const target = selectorOf(args.target)
      if (reference === undefined || target === undefined) return state
      return {
        ...state,
        revision: state.revision + 1,
        pendingTmScores: {
          ...state.pendingTmScores,
          [callId]: { callId, path: tab.path, reference, target },
        },
      }
    }

    case 'mol_capture': {
      const tab = tabOf(state, args)
      if (tab === undefined) return state
      const pending: MolPendingCapture = {
        callId,
        path: tab.path,
        ...(typeof args.width === 'number' ? { width: args.width } : {}),
        ...(typeof args.height === 'number' ? { height: args.height } : {}),
        ...(args.transparent === true ? { transparent: true } : {}),
      }
      return {
        ...state,
        revision: state.revision + 1,
        pending: { ...state.pending, [callId]: pending },
      }
    }

    case 'mol_inspect': {
      const tab = tabOf(state, args)
      if (tab === undefined) return state
      const target = args.target === undefined ? undefined : inspectTargetOf(args.target)
      if (args.target !== undefined && target === undefined) return state
      const pending: MolPendingInspect = {
        callId,
        path: tab.path,
        ...(target === undefined ? {} : { target }),
        ...(isInspectDetail(args.detail) ? { detail: args.detail } : {}),
        ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
      }
      return {
        ...state,
        revision: state.revision + 1,
        inspecting: { ...state.inspecting, [callId]: pending },
      }
    }

    default:
      return state
  }
}

function openScene(state: MolSessionState, args: Record<string, unknown>, callId: string): MolSessionState {
  const requested = typeof args.path === 'string' ? args.path : undefined
  if (requested === undefined) return state
  // `resolve` returns the Host-native spelling (`D:\work\x.pdb` on Windows);
  // the tab key must match the client's `/`-separated address path instead.
  const path = canonicalTabPath(
    isAbsolute(requested) ? requested : state.cwd === undefined ? requested : resolve(state.cwd, requested),
  )
  const format = formatOfFile(path)
  if (format === undefined) return state
  const target = args.select === undefined ? undefined : selectorOf(args.select)
  if (args.select !== undefined && target === undefined) return state
  const style = styleOf(args)
  if (style === undefined) return state
  const commands: MolCommand[] = [{ op: 'represent', style }]
  if (target !== undefined) {
    commands.push({ op: 'select', target, mode: 'highlight', ...(args.focus === true ? { focus: true } : {}) })
  } else if (args.focus === true) {
    commands.push({ op: 'focus' })
  }
  const scene: MolSceneState = {
    sceneKey: `${path}#${callId}`,
    path,
    format,
    label: baseNameOf(path),
    structures: [{ id: PRIMARY_STRUCTURE_ID, path, format, label: baseNameOf(path), callId }],
    commands,
  }
  return {
    ...state,
    revision: state.revision + 1,
    tabs: { ...state.tabs, [path]: scene },
    active: path,
  }
}

function tabOf(state: MolSessionState, args: Record<string, unknown>): MolSceneState | undefined {
  const requested = typeof args.tab === 'string' ? args.tab : undefined
  // Agents may echo the native spelling they got from a shell or an `@`
  // reference; both spellings address the same tab.
  const key = requested === undefined ? state.active : canonicalTabPath(requested)
  if (key === null) return undefined
  return state.tabs[key]
}

function withAlignment(
  state: MolSessionState,
  tab: MolSceneState,
  command: MolCommand,
  callId: string,
): MolSessionState {
  return {
    ...state,
    revision: state.revision + 1,
    tabs: {
      ...state.tabs,
      [tab.path]: { ...tab, commands: [...tab.commands, command] },
    },
    pendingAligns: {
      ...state.pendingAligns,
      [callId]: { callId, path: tab.path, commandIndex: tab.commands.length },
    },
  }
}

function withCommands(state: MolSessionState, key: string, commands: MolCommand[]): MolSessionState {
  const tab = state.tabs[key]
  if (tab === undefined) return state
  return {
    ...state,
    revision: state.revision + 1,
    tabs: { ...state.tabs, [key]: { ...tab, commands } },
  }
}

/** The primary structure id assigned by `load`/`mol_open`. */
export const PRIMARY_STRUCTURE_ID = 'structure'

/** Structures that have not been removed by a later command. */
function activeStructures(tab: MolSceneState): readonly MolSceneStructure[] {
  const retired = new Set<string>()
  for (const command of tab.commands) {
    if (command.op === 'remove-structure') retired.add(command.structureId)
  }
  return structuresOfScene(tab).filter(structure => !retired.has(structure.id))
}

function styleOf(args: Record<string, unknown>): StyleSpec | undefined {
  const style: {
    type?: StyleSpec['type']
    color?: StyleSpec['color']
    colorParams?: { value?: string | number }
  } = {}
  if (typeof args.type === 'string') style.type = args.type as StyleSpec['type']
  if (typeof args.color === 'string') style.color = args.color as StyleSpec['color']
  if (typeof args.colorParams === 'object' && args.colorParams !== null) {
    const candidate = args.colorParams as Record<string, unknown>
    if (candidate.value !== undefined) {
      // A projection must never throw: an invalid colour leaves the tool call
      // folded out, and the Host tool reports the validation error.
      try {
        style.colorParams = { value: parseColor(candidate.value) }
      } catch {
        return undefined
      }
    }
  }
  return Object.keys(style).length === 0 ? { type: 'cartoon', color: 'chain-id' } : style
}

function selectorOf(value: unknown): StructureSelector | undefined {
  try {
    return normalizeSelector(value)
  } catch {
    return undefined
  }
}

/** A structure selector, or one of the live viewer selections an inspection accepts. */
function inspectTargetOf(value: unknown): InspectTarget | undefined {
  if (typeof value === 'object' && value !== null) {
    const kind = (value as { kind?: unknown }).kind
    if (typeof kind === 'string' && LIVE_INSPECT_KINDS.has(kind)) return { kind: kind as 'selection' | 'focus' }
  }
  return selectorOf(value)
}
