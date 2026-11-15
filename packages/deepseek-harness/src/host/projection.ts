/**
 * The `mol4agent` session projection: tool calls become a durable, replayable
 * scene the browser viewer subscribes to.
 *
 * @module @gcszhn/mol4agent-deepseekharness/host/projection
 */
import { isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { MolCommand, StyleSpec, StructureSelector } from '@gcszhn/mol4agent-core/protocol'
import { baseNameOf, formatOfFile } from '../formats.ts'
import { normalizeSelector } from '../selector.ts'
import {
  EMPTY_MOL_STATE,
  PROJECTION_KEY,
  type MolPendingCapture,
  type MolSceneState,
  type MolSessionState,
} from '../state.ts'

const MEASUREMENT_KINDS = new Set(['chain', 'residue', 'residues', 'comp', 'schema'])

const stateSchema = z.custom<MolSessionState>(
  value => typeof value === 'object' && value !== null && 'revision' in value && 'pending' in value,
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
    stateVersion: 1,
  } satisfies ProjectionDefinition<typeof PROJECTION_KEY, MolSessionState>
}

function fold(state: MolSessionState, event: SessionEvent): MolSessionState {
  if (event.type === 'tool/call') {
    return foldToolCall(state, String(event.data.name), String(event.data.callId), event.data.arguments)
  }
  if (event.type === 'tool/result') {
    const callId = String(event.data.message.toolCallId)
    if (!(callId in state.pending)) return state
    const pending = { ...state.pending }
    delete pending[callId]
    return { ...state, revision: state.revision + 1, pending }
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
      if (state.scene === null) return state
      const target = args.target === undefined ? undefined : selectorOf(args.target)
      if (args.target !== undefined && target === undefined) return state
      const command: MolCommand = {
        op: 'represent',
        style: styleOf(args),
        ...(target === undefined ? {} : { target }),
      }
      return withCommands(state, [...state.scene.commands, command])
    }

    case 'mol_focus': {
      if (state.scene === null) return state
      const target = args.target === undefined ? undefined : selectorOf(args.target)
      if (args.target !== undefined && target === undefined) return state
      const command: MolCommand = { op: 'focus', ...(target === undefined ? {} : { target }) }
      return withCommands(state, [...state.scene.commands, command])
    }

    case 'mol_select': {
      if (state.scene === null) return state
      const target = selectorOf(args.target)
      if (target === undefined) return state
      const command: MolCommand = {
        op: 'select',
        target,
        mode: args.mode === 'highlight' ? 'highlight' : 'select',
        ...(args.focus === true ? { focus: true } : {}),
      }
      return withCommands(state, [...state.scene.commands, command])
    }

    case 'mol_measure': {
      if (state.scene === null) return state
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
      return withCommands(state, [...state.scene.commands, command])
    }

    case 'mol_capture': {
      const pending: MolPendingCapture = {
        callId,
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

    default:
      return state
  }
}

function openScene(state: MolSessionState, args: Record<string, unknown>, callId: string): MolSessionState {
  const requested = typeof args.path === 'string' ? args.path : undefined
  if (requested === undefined) return state
  const path = isAbsolute(requested) ? requested : state.cwd === undefined ? requested : resolve(state.cwd, requested)
  const format = formatOfFile(path)
  if (format === undefined) return state
  const commands: MolCommand[] = [{ op: 'represent', style: styleOf(args) }]
  const target = selectorOf(args.select)
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
    commands,
  }
  return { ...state, revision: state.revision + 1, scene }
}

function withCommands(state: MolSessionState, commands: MolCommand[]): MolSessionState {
  if (state.scene === null) return state
  return {
    ...state,
    revision: state.revision + 1,
    scene: { ...state.scene, commands },
  }
}

function styleOf(args: Record<string, unknown>): StyleSpec {
  const style: {
    type?: StyleSpec['type']
    color?: StyleSpec['color']
    colorParams?: { value?: string | number }
  } = {}
  if (typeof args.type === 'string') style.type = args.type as StyleSpec['type']
  if (typeof args.color === 'string') style.color = args.color as StyleSpec['color']
  if (typeof args.colorParams === 'object' && args.colorParams !== null) {
    const candidate = args.colorParams as Record<string, unknown>
    if (typeof candidate.value === 'string' || typeof candidate.value === 'number') {
      style.colorParams = { value: candidate.value }
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
