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
import type { StructureRef } from 'molstar/lib/mol-plugin-state/manager/structure/hierarchy-state'
import { StructureElement } from 'molstar/lib/mol-model/structure.js'
import type { Expression } from 'molstar/lib/mol-script/language/expression'
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

/** True when the style uses Mol*'s polymer-and-ligand preset. */
export function usesPolymerAndLigandPreset(style: StyleSpec): boolean {
  return style.type === undefined || style.type === 'cartoon'
}

/**
 * Apply one `represent` command.
 *
 * `replace: true` (the default) clears the structure components first, whether
 * or not `target` is present; `target` then narrows only the new
 * representation's coverage. `replace: false` keeps every existing
 * representation and adds the new one. Returns the same structured result as
 * every other command.
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
    // Do not clear the scene for a selection that matches nothing: the command
    // would fail after destroying the previous view. `nullIfEmpty` makes the
    // component builder skip an empty selection, so this mirrors its check.
    if (replace && !matchesAnyStructure(structures, expression)) {
      return representFailed(command.op, command.target)
    }
    if (replace && !await clearRepresentations(plugin, structures)) {
      return {
        ok: false,
        op: command.op,
        code: 'REPRESENT_FAILED',
        message: 'could not remove the current representations',
      }
    }
    let targeted = 0
    for (const structure of structures) {
      const component = await plugin.builders.structure.tryCreateComponentFromExpression(
        structure.cell,
        expression,
        selectionKey(command.target),
        { label: 'mol4agent selection' },
      )
      if (component === undefined) continue
      // No tag: with `replace: false` every targeted style must add its own
      // representation, so two styles of the same selection stack instead of
      // updating one another. A `replace: true` command clears first, so it
      // still leaves exactly one.
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

/** Whether `expression` selects at least one atom in any loaded structure. */
function matchesAnyStructure(
  structures: readonly StructureRef[],
  expression: Expression,
): boolean {
  for (const structure of structures) {
    const data = structure.cell.obj?.data
    if (data === undefined) continue
    try {
      if (!StructureElement.Loci.isEmpty(StructureElement.Loci.fromExpression(data, expression))) return true
    } catch {
      // Treat an expression we cannot evaluate as no match: never clear the
      // scene for a selection the component builder may then fail to create.
    }
  }
  return false
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
