/**
 * Shared DSH adapter state. No Node, DOM, or Mol* imports, so both halves of
 * the bundle can use it.
 *
 * @module @gcszhn/mol4agent-deepseekharness/state
 */
import { isStructureId, type MolCommand, type MolFormat, type StructureSelector, type TmScoreResult } from '@gcszhn/mol4agent-core/protocol'
import type {
  InspectDetail,
  InspectResult,
  InspectTarget,
} from '@gcszhn/mol4agent-core/protocol'
import type {} from '@deepseek-ai/dsh-session-projection/types'

/** Projection key owned by this adapter. */
export const PROJECTION_KEY = 'mol4agent'

/** One structure in a tab scene; the first entry is the primary file. */
export interface MolSceneStructure {
  readonly id: string
  readonly path: string
  readonly format: MolFormat
  readonly label: string
  /** Tool call that created this entry; used by Host validation to recognize its own fold. */
  readonly callId?: string
}

/** One tab page scene, in DSH semantics (path + suffix-derived format). */
export interface MolSceneState {
  /** Changes when the agent opens a file anew; drives a reload on the client. */
  readonly sceneKey: string
  /** Canonical tab-page id: the `/`-separated absolute path (`D:/work/a.pdb`). */
  readonly path: string
  readonly format: MolFormat
  readonly label: string
  /**
   * Structures loaded into this scene. The primary structure is first; extra
   * entries were added with `mol_add_structure`. Older projections without this
   * field are treated as a single primary structure by the client.
   */
  readonly structures?: readonly MolSceneStructure[]
  /** Commands applied after the bytes load, in order. */
  readonly commands: readonly MolCommand[]
}

/** One alignment waiting for the browser's metrics. */
export interface MolPendingAlign {
  readonly callId: string
  readonly path: string
  /** Index of the align command in the tab's cumulative command list. */
  readonly commandIndex: number
}

/** One TM-score calculation waiting for the browser's answer. */
export interface MolPendingTmScore {
  readonly callId: string
  readonly path: string
  readonly reference: StructureSelector
  readonly target: StructureSelector
}

/** The browser's answer to one queued TM-score calculation. */
export type MolTmScoreAnswer =
  | { readonly ok: true; readonly result: TmScoreResult }
  | { readonly ok: false; readonly message: string }

/** One screenshot the agent asked for, paired with the tool call waiting on it. */
export interface MolPendingCapture {
  readonly callId: string
  readonly width?: number
  readonly height?: number
  readonly transparent?: boolean
  /** Scene path this capture belongs to; non-matching tabs must ignore it. */
  readonly path?: string
}

/**
 * One read-only query the agent asked for, paired with the tool call waiting
 * on it. No viewer command: the browser answers from current Mol* state.
 */
export interface MolPendingInspect {
  readonly callId: string
  readonly target?: InspectTarget
  readonly detail?: InspectDetail
  readonly limit?: number
  /** Scene path this query belongs to; non-matching tabs must ignore it. */
  readonly path?: string
}

/** The browser's answer to one queued query. */
export type MolInspectAnswer =
  | { readonly ok: true; readonly result: InspectResult }
  | { readonly ok: false; readonly message: string }

/** Whole client-visible projection value. */
export interface MolSessionState {
  readonly revision: number
  /** Session working directory captured at projection init, in the Host's native spelling. */
  readonly cwd?: string
  /** Canonical tab-page id to its independent viewer scene. */
  readonly tabs: Readonly<Record<string, MolSceneState>>
  /** Last tab opened by mol_open; tools default to it when tab is omitted. */
  readonly active: string | null
  readonly pending: Readonly<Record<string, MolPendingCapture>>
  /** Align calls waiting for the browser to report RMSD/TM-score. */
  readonly pendingAligns: Readonly<Record<string, MolPendingAlign>>
  readonly pendingTmScores: Readonly<Record<string, MolPendingTmScore>>
  readonly inspecting: Readonly<Record<string, MolPendingInspect>>
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Per-tab molecular viewer scenes, screenshot requests, and inspect queries. */
    mol4agent: MolSessionState
  }
}

/** Scene structures, with a single-primary fallback for older projections. */
export function structuresOfScene(scene: MolSceneState): readonly MolSceneStructure[] {
  return scene.structures ?? [{
    id: 'structure',
    path: scene.path,
    format: scene.format,
    label: scene.label,
  }]
}

/** Next deterministic default id (`structure-2`, `structure-3`, ...). */
export function nextStructureId(structures: readonly { readonly id: string }[]): string {
  let index = 2
  while (structures.some(structure => structure.id === `structure-${index}`)) index += 1
  return `structure-${index}`
}

/**
 * Resolve the id of an add-structure call.
 *
 * The DSH projection folds a tool call before its Host body runs, so the entry
 * carrying this call's id is part of the scene already. Trust that entry;
 * otherwise a fresh add would always look like a duplicate of itself.
 */
export function resolveAddStructureId(
  scene: MolSceneState,
  callId: string,
  requestedId: string | undefined,
): { readonly id: string; readonly error?: undefined } | { readonly id?: undefined; readonly error: string } {
  const structures = structuresOfScene(scene)
  const folded = structures.find(structure => structure.callId === callId)
  if (folded !== undefined) return { id: folded.id }
  const id = requestedId ?? nextStructureId(structures)
  if (!isStructureId(id)) {
    return { error: `invalid structure id "${id}"; use 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit` }
  }
  if (structures.some(structure => structure.id === id)) {
    return { error: `structure id "${id}" is already loaded; choose another id or use mol_list_structures first` }
  }
  return { id }
}

/** Initial value before any molecule tool call. */
export const EMPTY_MOL_STATE: MolSessionState = {
  revision: 0,
  tabs: {},
  active: null,
  pending: {},
  pendingAligns: {},
  pendingTmScores: {},
  inspecting: {},
}
