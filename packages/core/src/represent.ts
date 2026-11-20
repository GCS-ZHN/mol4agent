/**
 * The `represent` command: replace-vs-overlay policy and its Mol* mutations.
 *
 * Kept out of `viewer.ts` so the whole policy runs under plain Node against a
 * headless `PluginContext`. `replace` is explicit in the protocol; `target`
 * only narrows what the new representation covers, it never implies add or
 * replace. The default is replace, matching the documented no-target behavior.
 *
 * @module @gcszhn/mol4agent-core/represent
 */
import type { PluginContext } from 'molstar/lib/mol-plugin/context'
import type { StructureComponentRef, StructureRef } from 'molstar/lib/mol-plugin-state/manager/structure/hierarchy-state'
import { StructureElement, type Structure } from 'molstar/lib/mol-model/structure.js'
import {
  COLOR_THEMES,
  REPRESENTATION_TYPES,
  type CommandResult,
  type RepresentCommand,
  type StyleSpec,
  type StructureSelector,
} from './protocol.ts'
import { formatColor, parseColor } from './color.ts'
import { selectionKey, selectorExpression } from './select.ts'

/**
 * How many fresh all-atom components this viewer has created.
 *
 * A new key per global non-preset style keeps stacking (`replace: false`)
 * additive instead of updating a previous component in place.
 */
let globalComponentSeq = 0

/** Fresh component key per targeted replace so a trimmed remainder is never reused. */
let targetComponentSeq = 0

type ElementLoci = ReturnType<typeof StructureElement.Loci.fromExpression>

/** True when the style uses Mol*'s polymer-and-ligand preset. */
export function usesPolymerAndLigandPreset(style: StyleSpec): boolean {
  return style.type === undefined || style.type === 'cartoon'
}

/**
 * Apply one `represent` command.
 *
 * Without a target, `replace: true` (the default) clears the scoped structures
 * first. With a target, it replaces only representations covering that target:
 * components entirely inside the target are removed, partially covered
 * components are trimmed to their non-target remainder, and everything else is
 * left untouched. `replace: false` keeps every existing representation and
 * adds the new one. Returns the same structured result as every other command.
 */
export async function applyRepresentation(
  plugin: PluginContext,
  command: RepresentCommand,
  scopedStructures?: readonly StructureRef[],
): Promise<CommandResult> {
  const style = command.style
  if (style.type !== undefined && !(REPRESENTATION_TYPES as readonly string[]).includes(style.type)) {
    return invalid(command.op, `unknown representation "${style.type}"; supported: ${REPRESENTATION_TYPES.join(', ')}`)
  }
  if (style.color !== undefined && !(COLOR_THEMES as readonly string[]).includes(style.color)) {
    return invalid(command.op, `unknown colour theme "${style.color}"; supported: ${COLOR_THEMES.join(', ')}`)
  }
  // Normalize once, before touching the scene: a bad color must fail the
  // command instead of reaching Mol* and painting the structure black.
  let resolvedColor: number | undefined
  if (style.colorParams?.value !== undefined) {
    try {
      resolvedColor = parseColor(style.colorParams.value)
    } catch (error) {
      return invalid(command.op, error instanceof Error ? error.message : String(error))
    }
  }
  const colorParams = resolvedColor === undefined ? undefined : { value: resolvedColor }
  const colorSuffix = resolvedColor === undefined ? '' : ` ${formatColor(resolvedColor)}`

  const structures = scopedStructures ?? plugin.managers.structure.hierarchy.current.structures
  if (structures.length === 0) {
    return { ok: false, op: command.op, code: 'NO_STRUCTURE', message: 'no structure is loaded' }
  }

  const replace = command.replace !== false

  if (command.target !== undefined) {
    const expression = selectorExpression(command.target)
    if (replace) {
      // Replace inside the target instead of clearing the scoped structures:
      // chain B must not erase the cartoon that still draws chain A.
      let matched = 0
      for (const structure of structures) {
        const data = structure.cell.obj?.data
        if (data === undefined) continue
        let targetLoci: ElementLoci
        try {
          targetLoci = StructureElement.Loci.fromExpression(data, expression)
        } catch {
          continue
        }
        if (StructureElement.Loci.isEmpty(targetLoci)) continue
        matched += 1
        if (!await replaceTargetRepresentations(plugin, structure, data, targetLoci)) {
          return {
            ok: false,
            op: command.op,
            code: 'REPRESENT_FAILED',
            message: 'could not replace the representations covering the target',
          }
        }
      }
      // Never clear the scene for a selection that matches nothing: the
      // command would fail after destroying the previous view.
      if (matched === 0) return representFailed(command.op, command.target)
    }
    // A fresh key is required for replace: a partially covered component may
    // have been trimmed to a remainder above, and reusing its key would flip
    // that remainder back to the target.
    const componentKey = replace
      ? `mol4agent-target-${targetComponentSeq += 1}`
      : selectionKey(command.target)
    let targeted = 0
    for (const structure of structures) {
      const component = await plugin.builders.structure.tryCreateComponentFromExpression(
        structure.cell,
        expression,
        componentKey,
        { label: 'mol4agent selection' },
      )
      if (component === undefined) continue
      // No tag: with `replace: false` every targeted style must add its own
      // representation, so two styles of the same selection stack instead of
      // updating one another. With `replace: true` the target coverage was
      // removed from the existing components above, so this fresh component
      // still leaves exactly one representation over the target.
      const rep = await plugin.builders.structure.representation.addRepresentation(component as never, {
        type: (style.type ?? 'ball-and-stick') as never,
        color: (style.color ?? 'uniform') as never,
        ...(colorParams === undefined ? {} : { colorParams: colorParams as never }),
      })
      if (rep !== undefined) targeted += 1
    }
    if (targeted === 0) return representFailed(command.op, command.target)
    plugin.canvas3d?.requestDraw()
    return {
      ok: true,
      op: command.op,
      message: `applied ${style.type ?? 'ball-and-stick'} / ${style.color ?? 'uniform'}${colorSuffix} to ${command.target.kind}`,
    }
  }

  if (replace && !await clearRepresentations(plugin, structures)) {
    return {
      ok: false,
      op: command.op,
      code: 'REPRESENT_FAILED',
      message: 'could not remove the current representations',
    }
  }

  // A single Cartoon representation hides HETATM ligands. Use Mol*'s
  // polymer-and-ligand preset for the default cartoon style so ATP/HEM/etc.
  // stay visible. A uniform colorParams is passed through the preset theme so
  // "gray cartoon" still keeps the ligand representation.
  let added = 0
  if (usesPolymerAndLigandPreset(style)) {
    for (const structure of structures) {
      await plugin.builders.structure.representation.applyPreset(
        structure.cell,
        'polymer-and-ligand',
        {
          theme: {
            globalName: style.color ?? 'chain-id',
            ...(colorParams === undefined ? {} : { globalColorParams: colorParams }),
          },
        } as never,
      )
      added += 1
    }
  } else {
    // Representations live under components. Build one fresh all-atom
    // component per structure. With replace: false the previous components
    // stay, so every new style needs its own key.
    const all = selectorExpression({ kind: 'all' })
    for (const structure of structures) {
      const component = await plugin.builders.structure.tryCreateComponentFromExpression(
        structure.cell,
        all,
        `mol4agent-global-${globalComponentSeq += 1}`,
        { label: 'mol4agent global' },
      )
      if (component === undefined) continue
      const rep = await plugin.builders.structure.representation.addRepresentation(component as never, {
        type: (style.type ?? 'cartoon') as never,
        color: (style.color ?? 'chain-id') as never,
        ...(colorParams === undefined ? {} : { colorParams: colorParams as never }),
      })
      if (rep !== undefined) added += 1
    }
  }
  if (added === 0) {
    return {
      ok: false,
      op: command.op,
      code: 'REPRESENT_FAILED',
      message: `Mol* did not create a representation for ${style.type ?? 'cartoon'}`,
    }
  }
  plugin.canvas3d?.requestDraw()
  return {
    ok: true,
    op: command.op,
    message: `applied ${style.type ?? 'cartoon'} / ${style.color ?? 'chain-id'}${colorSuffix}`,
  }
}

/**
 * Remove the target portion from every existing representation.
 *
 * Components fully inside the target are removed. A component that straddles
 * the target keeps its representations but is updated in place to draw only
 * its non-target remainder, so another chain's cartoon survives when only one
 * chain is restyled. Components outside the target are untouched.
 */
async function replaceTargetRepresentations(
  plugin: PluginContext,
  structure: StructureRef,
  parent: Structure,
  target: ElementLoci,
): Promise<boolean> {
  const trimmed: Array<{
    component: StructureComponentRef
    remainder: ReturnType<typeof StructureElement.Bundle.fromLoci>
  }> = []
  const removed: StructureComponentRef[] = []

  for (const component of [...structure.components]) {
    const data = component.cell.obj?.data
    if (data === undefined) continue
    let componentLoci: ElementLoci
    try {
      const bundle = StructureElement.Bundle.fromSubStructure(parent, data)
      componentLoci = StructureElement.Bundle.toLoci(bundle, parent)
    } catch (reason) {
      // A component that cannot be mapped onto the parent structure is not a
      // representation this command can safely edit; leave it alone.
      console.warn('[mol4agent] could not map a component onto the structure', reason)
      continue
    }
    if (StructureElement.Loci.isEmpty(StructureElement.Loci.intersect(componentLoci, target))) continue
    const remainder = StructureElement.Loci.subtract(componentLoci, target)
    if (StructureElement.Loci.isEmpty(remainder)) {
      removed.push(component)
    } else {
      trimmed.push({ component, remainder: StructureElement.Bundle.fromLoci(remainder) })
    }
  }

  for (const { component, remainder } of trimmed) {
    try {
      await plugin.state.data.build()
        .to(component.cell)
        .update({
          type: { name: 'bundle', params: remainder },
          nullIfEmpty: true,
          label: component.cell.obj?.label ?? '',
        })
        .commit()
    } catch (reason) {
      console.warn('[mol4agent] could not trim a representation to the target', reason)
      return false
    }
  }
  if (removed.length > 0) {
    try {
      await plugin.managers.structure.hierarchy.remove(removed, true)
    } catch (reason) {
      console.warn('[mol4agent] could not remove the targeted representations', reason)
      return false
    }
  }
  return true
}

/** Remove every structure component, i.e. every agent or human representation. */
async function clearRepresentations(
  plugin: PluginContext,
  structures: readonly StructureRef[],
): Promise<boolean> {
  const components = structures.flatMap(structure => [...structure.components])
  if (components.length === 0) return true
  try {
    await plugin.managers.structure.hierarchy.remove(components, true)
    return true
  } catch (reason) {
    console.warn('[mol4agent] could not remove the current representations', reason)
    return false
  }
}

function representFailed(op: RepresentCommand['op'], target: StructureSelector): CommandResult {
  return {
    ok: false,
    op,
    code: 'REPRESENT_FAILED',
    message: `Mol* did not create a representation for ${target.kind}`,
  }
}

function invalid(op: RepresentCommand['op'], message: string): CommandResult {
  return { ok: false, op, code: 'INVALID_COMMAND', message }
}
