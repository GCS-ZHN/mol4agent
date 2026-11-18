/**
 * Viewer-side inspection: resolve an {@link InspectRequest} against the live
 * Mol* plugin and assemble the result.
 *
 * Everything here reads current state, never the session log, so a human who
 * clicked a residue or switched a representation in the Mol* panel is visible
 * to the agent exactly as the screen shows it.
 *
 * @module @gcszhn/mol4agent-core/inspect-plugin
 */
import type { PluginContext } from 'molstar/lib/mol-plugin/context'
import { StructureElement, StructureProperties, Unit, type Structure } from 'molstar/lib/mol-model/structure'
import { StateTransforms } from 'molstar/lib/mol-plugin-state/transforms'
import { formatColor } from './color.ts'
import {
  buildInspectResult,
  resolveOverpaint,
  visibleColorOf,
  type OverpaintLayerKeys,
  type ResidueRecord,
} from './inspect.ts'
import { extractResidues } from './inspect-mol.ts'
import {
  Mol4AgentError,
  type InspectAppearance,
  type InspectOverlay,
  type InspectRequest,
  type InspectResult,
  type InspectSelection,
  type InspectSelectionGroup,
  type InspectStyle,
  type InspectTarget,
} from './protocol.ts'
import { describeSelector, selectorExpression } from './select.ts'

/** One inspected target resolved to concrete Mol* locations. */
interface ResolvedTarget {
  readonly label: string
  readonly loci: readonly StructureElement.Loci[]
  /** Structures that contribute to this target, for style matching. */
  readonly structures: readonly Structure[]
}

/** Structure identity of one residue, independent of which representation draws it. */
function residueKeyOfLocation(location: StructureElement.Location): string {
  return [
    StructureProperties.chain.auth_asym_id(location),
    StructureProperties.residue.auth_seq_id(location),
    StructureProperties.residue.label_comp_id(location),
  ].join('|')
}

function residueKeyOfRecord(record: ResidueRecord): string {
  return [record.chain, record.seqId, record.compId].join('|')
}

/** Atom identity independent of which structure instance holds it. */
function atomKeyOfLocation(location: StructureElement.Location): string {
  return [
    residueKeyOfLocation(location),
    StructureProperties.atom.label_atom_id(location),
  ].join('|')
}

/** Every atom of the given locations, keyed the same way as `atomKeyOfLocation`. */
function atomKeysOf(lociList: readonly StructureElement.Loci[]): Set<string> {
  const keys = new Set<string>()
  for (const loci of lociList) {
    StructureElement.Loci.forEachLocation(loci, location => {
      if (Unit.isAtomic(location.unit)) keys.add(atomKeyOfLocation(location))
    })
  }
  return keys
}

/** Every loaded structure object in the viewer, skipping unbuilt hierarchy entries. */
function loadedStructures(plugin: PluginContext): Structure[] {
  const structures: Structure[] = []
  for (const ref of plugin.managers.structure.hierarchy.current.structures) {
    // Prefer the decorated structure so coordinates match what the page shows
    // after an alignment transform; it is the same object when untransformed.
    const structure = ref.transform?.cell.obj?.data ?? ref.cell.obj?.data
    if (structure !== undefined) structures.push(structure)
  }
  return structures
}

type StructuresFor = (structureId: string) => Structure[]

function targetLocations(
  plugin: PluginContext,
  target: InspectTarget,
  structuresFor?: StructuresFor,
): ResolvedTarget {
  const scoped = target.kind !== 'selection' && target.kind !== 'focus' && target.structureId !== undefined
  const structures = scoped && structuresFor !== undefined
    ? structuresFor(target.structureId!)
    : loadedStructures(plugin)
  if (structures.length === 0) throw new Mol4AgentError('NO_STRUCTURE', 'no structure is loaded')
  if (target.kind === 'selection') {
    const loci: StructureElement.Loci[] = []
    for (const entry of plugin.managers.structure.selection.entries.values()) {
      if (!StructureElement.Loci.isEmpty(entry.selection)) loci.push(entry.selection)
    }
    return { label: 'selection', loci, structures }
  }
  if (target.kind === 'focus') {
    const current = plugin.managers.structure.focus.current
    const empty = current === undefined || StructureElement.Loci.isEmpty(current.loci)
    return { label: 'focus', loci: empty ? [] : [current.loci], structures }
  }
  if (target.kind === 'all') {
    return { label: 'whole structure', loci: structures.map(structure => StructureElement.Loci.all(structure)), structures }
  }
  const expression = selectorExpression(target)
  const loci: StructureElement.Loci[] = []
  for (const structure of structures) {
    const selected = StructureElement.Loci.fromExpression(structure, expression)
    if (!StructureElement.Loci.isEmpty(selected)) loci.push(selected)
  }
  const label = describeSelector(target)
  return {
    label: target.structureId === undefined ? label : `${label} [${target.structureId}]`,
    loci,
    structures,
  }
}

/** Residue and atom totals of a set of locations, walked once. */
function totalsOf(loci: readonly StructureElement.Loci[]): { atoms: number; residues: number } {
  const records = extractResidues(loci).records
  let atoms = 0
  for (const record of records) atoms += record.atoms.length
  return { atoms, residues: records.length }
}

/**
 * Totals for one or more live selections.
 *
 * `entries` are reported one row each so disjoint selection entries stay
 * distinguishable; the top-level totals are the union, which is smaller than
 * the sum of the per-entry rows when entries overlap.
 */
function summarize(
  input: readonly (StructureElement.Loci | undefined)[],
  withGroups = false,
): InspectSelection | undefined {
  const loci = input.filter((entry): entry is StructureElement.Loci =>
    entry !== undefined && !StructureElement.Loci.isEmpty(entry))
  if (loci.length === 0) return undefined
  const summary: InspectSelection = { entries: loci.length, ...totalsOf(loci) }
  if (!withGroups) return summary
  const groups: InspectSelectionGroup[] = loci.map(entry => totalsOf([entry]))
  return { ...summary, groups }
}

/** Keep only JSON-safe theme parameters; Mol* params may hold objects and Colors. */
function safeColorParams(params: unknown): Record<string, string | number | boolean> | undefined {
  if (typeof params !== 'object' || params === null) return undefined
  const safe: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') safe[key] = value
  }
  return Object.keys(safe).length === 0 ? undefined : safe
}

/**
 * Ask the representation's own color theme for the colour it paints at `location`.
 *
 * Themes needing custom properties (e.g. hydrophobicity) can fail outside a
 * rendered scene; the style row still reports its theme name in that case.
 */
function themeColor(
  plugin: PluginContext,
  colorTheme: string,
  params: Record<string, unknown> | undefined,
  location: StructureElement.Location,
): number | undefined {
  try {
    const provider = plugin.representation.structure.themes.colorThemeRegistry.get(colorTheme)
    const theme = provider.factory(
      { structure: location.structure } as never,
      (params ?? provider.defaultValues) as never,
    ) as unknown as { color?: (location: StructureElement.Location, secondary: boolean) => number }
    if (typeof theme.color !== 'function') return undefined
    return theme.color(location, false)
  } catch {
    return undefined
  }
}

/** One location inside `structure` whose residue is part of the inspected target. */
function firstTargetLocation(structure: Structure, keys: ReadonlySet<string>): StructureElement.Location | undefined {
  let hit: StructureElement.Location | undefined
  StructureElement.Loci.forEachLocation(StructureElement.Loci.all(structure), location => {
    if (hit !== undefined || !Unit.isAtomic(location.unit)) return
    if (keys.has(residueKeyOfLocation(location))) hit = StructureElement.Location.clone(location)
  })
  return hit
}

interface RepresentationParams {
  readonly type?: { readonly name?: unknown }
  readonly colorTheme?: { readonly name?: unknown; readonly params?: Record<string, unknown> }
  readonly sizeTheme?: { readonly name?: unknown }
}

/** One bundle-based overpaint layer stored on a representation. */
interface OverpaintLayer {
  readonly bundle: unknown
  readonly color: number
  readonly clear: boolean
}

/**
 * Overpaint layers attached to one representation, in application order.
 *
 * Mol* stores overpaint as a transform layered on the representation, so these
 * are its child transforms in the state tree. Script-based layers are skipped:
 * resolving a Mol*Script selection needs the script engine, and the UI only
 * ever writes bundle layers.
 */
function overpaintLayers(plugin: PluginContext, representationRef: string): OverpaintLayer[] {
  const tree = plugin.state.data.tree
  const children = tree.children.get(representationRef)
  if (children === undefined) return []
  const layers: OverpaintLayer[] = []
  children.forEach(childRef => {
    const transform = tree.transforms.get(childRef)
    if (transform === undefined) return
    if (transform.transformer !== StateTransforms.Representation.OverpaintStructureRepresentation3DFromBundle) return
    const params = transform.params as { readonly layers?: readonly OverpaintLayer[] } | undefined
    for (const layer of params?.layers ?? []) layers.push(layer)
  })
  return layers
}

/**
 * Overpaint colour covering one atom of a representation, plus the overlay row.
 *
 * Layers apply in order: a layer whose bundle contains the atom sets the colour,
 * and a `clear` layer resets it back to the theme colour. The atom is matched by
 * structure identity, so a bundle built against the root structure still matches
 * an atom seen through a component substructure.
 */
function overpaintFor(
  plugin: PluginContext,
  representationRef: string,
  root: Structure,
  atomKey: string,
  label: string,
): { readonly color?: number; readonly overlays: readonly InspectOverlay[] } {
  const resolved: OverpaintLayerKeys[] = []
  for (const layer of overpaintLayers(plugin, representationRef)) {
    try {
      resolved.push({
        keys: atomKeysOf([StructureElement.Bundle.toLoci(layer.bundle as never, root)]),
        color: layer.color,
        clear: layer.clear,
      })
    } catch {
      // A layer that cannot be resolved is skipped rather than failing the query.
    }
  }
  const applied = resolveOverpaint(resolved, atomKey)
  if (applied === undefined) return { overlays: [] }
  return {
    color: applied,
    overlays: [{ source: 'overpaint', color: formatColor(applied), label }],
  }
}

/** The canvas selection marker that tints selected elements. */
interface CanvasMarker {
  readonly selectColor: number
  readonly selectStrength: number
  /** True when the marker is drawn as edges only and does not tint the body colour. */
  readonly edgesOnly: boolean
}

function canvasMarker(plugin: PluginContext): CanvasMarker | undefined {
  const renderer = plugin.canvas3d?.props.renderer
  if (renderer === undefined) return undefined
  return {
    selectColor: renderer.selectColor,
    selectStrength: typeof renderer.selectStrength === 'number' ? renderer.selectStrength : 0,
    edgesOnly: renderer.colorMarker !== true,
  }
}

/** The selection overlay for one atom, when that atom is currently selected. */
function selectionOverlayFor(
  marker: CanvasMarker | undefined,
  selectionKeys: ReadonlySet<string> | undefined,
  atomKey: string,
): InspectOverlay | undefined {
  if (marker === undefined || selectionKeys === undefined || !selectionKeys.has(atomKey)) return undefined
  return {
    source: 'selection',
    color: formatColor(marker.selectColor),
    strength: marker.selectStrength,
    ...(marker.edgesOnly ? { hidden: true } : {}),
  }
}

/**
 * Representations that currently draw any residue of the target.
 *
 * Matching uses structure identity (chain, sequence id, component id) rather
 * than unit instances, so the same residue in a symmetry copy or in a
 * selection component still reports the style that colours it on screen.
 */
function collectStyles(
  plugin: PluginContext,
  targetKeys: ReadonlySet<string>,
  targetStructures: readonly Structure[],
  selectionKeys: ReadonlySet<string> | undefined,
): InspectStyle[] {
  const styles: InspectStyle[] = []
  const marker = canvasMarker(plugin)
  for (const structureRef of plugin.managers.structure.hierarchy.current.structures) {
    const structure = structureRef.transform?.cell.obj?.data ?? structureRef.cell.obj?.data
    if (structure === undefined || !targetStructures.includes(structure)) continue
    for (const component of structureRef.components) {
      const structure = component.cell.obj?.data
      if (structure === undefined) continue
      const location = firstTargetLocation(structure, targetKeys)
      if (location === undefined) continue
      const atomKey = atomKeyOfLocation(location)
      const label = component.cell.obj?.label ?? 'component'
      const componentHidden = component.cell.transform.state.isHidden === true
      for (const representation of component.representations) {
        const values = representation.cell.params?.values as RepresentationParams | undefined
        const type = typeof values?.type?.name === 'string' ? values.type.name : 'unknown'
        const colorTheme = typeof values?.colorTheme?.name === 'string' ? values.colorTheme.name : 'unknown'
        const sizeTheme = typeof values?.sizeTheme?.name === 'string' ? values.sizeTheme.name : 'unknown'
        const params = values?.colorTheme?.params
        const colorParams = safeColorParams(params)
        const baseColor = themeColor(plugin, colorTheme, params, location)
        const overpaint = overpaintFor(plugin, representation.cell.transform.ref, structure.root, atomKey, type)
        const selection = selectionOverlayFor(marker, selectionKeys, atomKey)
        const overlays: InspectOverlay[] = [
          ...overpaint.overlays,
          ...(selection === undefined ? [] : [selection]),
        ]
        // `selection` only exists when a marker does, so the marker options and
        // the selected flag stay consistent.
        const visibleColor = visibleColorOf(
          baseColor,
          overpaint.color,
          selection !== undefined,
          marker === undefined
            ? undefined
            : { color: marker.selectColor, strength: marker.selectStrength, edgesOnly: marker.edgesOnly },
        )
        const hidden = componentHidden || representation.cell.transform.state.isHidden === true
        styles.push({
          component: label,
          type,
          color: colorTheme,
          size: sizeTheme,
          ...(colorParams === undefined ? {} : { colorParams }),
          ...(baseColor === undefined ? {} : { baseColor: formatColor(baseColor) }),
          ...(visibleColor === undefined ? {} : { visibleColor: formatColor(visibleColor) }),
          ...(overlays.length === 0 ? {} : { overlays }),
          ...(hidden ? { hidden: true } : {}),
        })
      }
    }
  }
  return styles
}

/**
 * Effective appearance of the target: the last drawn style and its overlays.
 *
 * Several representations can cover one target (e.g. a cartoon plus a selection
 * component), so this reports the one drawn last rather than inventing a merged
 * colour; per-representation values stay in `styles`.
 */
function appearanceOf(styles: readonly InspectStyle[]): InspectAppearance {
  for (let index = styles.length - 1; index >= 0; index -= 1) {
    const style = styles[index]
    if (style === undefined || style.hidden === true) continue
    return {
      ...(style.baseColor === undefined ? {} : { baseColor: style.baseColor }),
      ...(style.visibleColor === undefined ? {} : { visibleColor: style.visibleColor }),
      overlays: style.overlays ?? [],
    }
  }
  return { overlays: [] }
}

/**
 * Inspect the loaded structure and the way the viewer draws it.
 *
 * Throws {@link Mol4AgentError} with `NO_STRUCTURE` when nothing is loaded; an
 * empty selection or focus is a valid empty result instead of an error.
 */
export function inspectViewer(
  plugin: PluginContext,
  request: InspectRequest = {},
  structuresFor?: StructuresFor,
): InspectResult {
  const target = targetLocations(plugin, request.target ?? { kind: 'all' }, structuresFor)
  const detail = request.detail ?? 'summary'
  // Resolving the target is what makes the totals describe the requested
  // scope; the style probe additionally needs residue identity.
  const extracted = extractResidues(target.loci)
  const keys = new Set(extracted.records.map(residueKeyOfRecord))
  const selectionLocis = [...plugin.managers.structure.selection.entries.values()].map(entry => entry.selection)
  const selection = summarize(selectionLocis, true)
  const focus = summarize([plugin.managers.structure.focus.current?.loci])
  const selectionKeys = selection === undefined ? undefined : atomKeysOf(selectionLocis)
  const styles = collectStyles(plugin, keys, target.structures, selectionKeys)
  return buildInspectResult({
    target: target.label,
    detail,
    chains: extracted.chains,
    models: extracted.models,
    records: extracted.records,
    styles,
    // An empty target carries no appearance: nothing is drawn to describe.
    ...(extracted.records.length === 0 ? {} : { appearance: appearanceOf(styles) }),
    ...(selection === undefined ? {} : { selection }),
    ...(focus === undefined ? {} : { focus }),
    ...(request.limit === undefined ? {} : { limit: request.limit }),
  })
}
