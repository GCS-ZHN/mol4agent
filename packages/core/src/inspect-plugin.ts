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
import { formatColor } from './color.ts'
import { buildInspectResult, type ResidueRecord } from './inspect.ts'
import { extractResidues } from './inspect-mol.ts'
import {
  Mol4AgentError,
  type InspectRequest,
  type InspectResult,
  type InspectSelection,
  type InspectStyle,
  type InspectTarget,
} from './protocol.ts'
import { describeSelector, selectorExpression } from './select.ts'

/** One inspected target resolved to concrete Mol* locations. */
interface ResolvedTarget {
  readonly label: string
  readonly loci: readonly StructureElement.Loci[]
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

/** Every loaded structure object in the viewer, skipping unbuilt hierarchy entries. */
function loadedStructures(plugin: PluginContext): Structure[] {
  const structures: Structure[] = []
  for (const ref of plugin.managers.structure.hierarchy.current.structures) {
    const structure = ref.cell.obj?.data
    if (structure !== undefined) structures.push(structure)
  }
  return structures
}

function targetLocations(plugin: PluginContext, target: InspectTarget): ResolvedTarget {
  const structures = loadedStructures(plugin)
  if (structures.length === 0) throw new Mol4AgentError('NO_STRUCTURE', 'no structure is loaded')
  if (target.kind === 'selection') {
    const loci: StructureElement.Loci[] = []
    for (const entry of plugin.managers.structure.selection.entries.values()) {
      if (!StructureElement.Loci.isEmpty(entry.selection)) loci.push(entry.selection)
    }
    return { label: 'selection', loci }
  }
  if (target.kind === 'focus') {
    const current = plugin.managers.structure.focus.current
    const empty = current === undefined || StructureElement.Loci.isEmpty(current.loci)
    return { label: 'focus', loci: empty ? [] : [current.loci] }
  }
  if (target.kind === 'all') {
    return { label: 'whole structure', loci: structures.map(structure => StructureElement.Loci.all(structure)) }
  }
  const expression = selectorExpression(target)
  const loci: StructureElement.Loci[] = []
  for (const structure of structures) {
    const selected = StructureElement.Loci.fromExpression(structure, expression)
    if (!StructureElement.Loci.isEmpty(selected)) loci.push(selected)
  }
  return { label: describeSelector(target), loci }
}

/** Totals for one or more live selections, without listing their content. */
function summarize(input: readonly (StructureElement.Loci | undefined)[]): InspectSelection | undefined {
  const loci = input.filter((entry): entry is StructureElement.Loci =>
    entry !== undefined && !StructureElement.Loci.isEmpty(entry))
  if (loci.length === 0) return undefined
  const extracted = extractResidues(loci)
  let atoms = 0
  for (const record of extracted.records) atoms += record.atoms.length
  return { entries: loci.length, atoms, residues: extracted.records.length }
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
function resolveColor(
  plugin: PluginContext,
  colorTheme: string,
  params: Record<string, unknown> | undefined,
  location: StructureElement.Location,
): string | undefined {
  try {
    const provider = plugin.representation.structure.themes.colorThemeRegistry.get(colorTheme)
    const theme = provider.factory(
      { structure: location.structure } as never,
      (params ?? provider.defaultValues) as never,
    ) as unknown as { color?: (location: StructureElement.Location, secondary: boolean) => number }
    if (typeof theme.color !== 'function') return undefined
    return formatColor(theme.color(location, false))
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

/**
 * Representations that currently draw any residue of the target.
 *
 * Matching uses structure identity (chain, sequence id, component id) rather
 * than unit instances, so the same residue in a symmetry copy or in a
 * selection component still reports the style that colours it on screen.
 */
function collectStyles(plugin: PluginContext, targetKeys: ReadonlySet<string>): InspectStyle[] {
  const styles: InspectStyle[] = []
  for (const structureRef of plugin.managers.structure.hierarchy.current.structures) {
    for (const component of structureRef.components) {
      const structure = component.cell.obj?.data
      if (structure === undefined) continue
      const location = firstTargetLocation(structure, targetKeys)
      if (location === undefined) continue
      const label = component.cell.obj?.label ?? 'component'
      const componentHidden = component.cell.transform.state.isHidden === true
      for (const representation of component.representations) {
        const values = representation.cell.params?.values as RepresentationParams | undefined
        const type = typeof values?.type?.name === 'string' ? values.type.name : 'unknown'
        const colorTheme = typeof values?.colorTheme?.name === 'string' ? values.colorTheme.name : 'unknown'
        const sizeTheme = typeof values?.sizeTheme?.name === 'string' ? values.sizeTheme.name : 'unknown'
        const params = values?.colorTheme?.params
        const colorParams = safeColorParams(params)
        const colorValue = resolveColor(plugin, colorTheme, params, location)
        const hidden = componentHidden || representation.cell.transform.state.isHidden === true
        styles.push({
          component: label,
          type,
          color: colorTheme,
          size: sizeTheme,
          ...(colorParams === undefined ? {} : { colorParams }),
          ...(colorValue === undefined ? {} : { colorValue }),
          ...(hidden ? { hidden: true } : {}),
        })
      }
    }
  }
  return styles
}

/**
 * Inspect the loaded structure and the way the viewer draws it.
 *
 * Throws {@link Mol4AgentError} with `NO_STRUCTURE` when nothing is loaded; an
 * empty selection or focus is a valid empty result instead of an error.
 */
export function inspectViewer(plugin: PluginContext, request: InspectRequest = {}): InspectResult {
  const target = targetLocations(plugin, request.target ?? { kind: 'all' })
  const detail = request.detail ?? 'summary'
  // Resolving the target is what makes the totals describe the requested
  // scope; the style probe additionally needs residue identity.
  const extracted = extractResidues(target.loci)
  const keys = new Set(extracted.records.map(residueKeyOfRecord))
  const selection = summarize([...plugin.managers.structure.selection.entries.values()].map(entry => entry.selection))
  const focus = summarize([plugin.managers.structure.focus.current?.loci])
  return buildInspectResult({
    target: target.label,
    detail,
    chains: extracted.chains,
    models: extracted.models,
    records: extracted.records,
    styles: collectStyles(plugin, keys),
    ...(selection === undefined ? {} : { selection }),
    ...(focus === undefined ? {} : { focus }),
    ...(request.limit === undefined ? {} : { limit: request.limit }),
  })
}
