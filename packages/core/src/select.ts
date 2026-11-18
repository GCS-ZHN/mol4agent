/** Selector compilation: protocol selectors to Mol* schemas/queries. @module @gcszhn/mol4agent-core/select */
import { StructureElement } from 'molstar/lib/mol-model/structure.js'
import { StructureSelectionQueries } from 'molstar/lib/mol-plugin-state/helpers/structure-selection-query.js'
import type { Expression } from 'molstar/lib/mol-script/language/expression'
import type { ElementSchema, StructureSelector } from './protocol.ts'

/** A selector compiled to the two shapes Mol*'s interactivity helper accepts. */
export type CompiledSelector =
  | { readonly elements: ElementSchema }
  | { readonly expression: (queryBuilder: unknown) => Expression }

/**
 * Compile one agent selector.
 *
 * Semantic categories reuse Mol*'s own built-in queries so the agent's
 * "ligand" means exactly what the Mol* UI means. Chain/residue selections use
 * `StructureElement.Schema`, which maps 1:1 to mmCIF atom_site fields and is
 * therefore easy for a model to emit as JSON.
 */
export function compileSelector(selector: StructureSelector): CompiledSelector {
  switch (selector.kind) {
    case 'all':
      return query(StructureSelectionQueries.all)
    case 'polymer':
      return query(StructureSelectionQueries.polymer)
    case 'protein':
      return query(StructureSelectionQueries.protein)
    case 'nucleic':
      return query(StructureSelectionQueries.nucleic)
    case 'ligand':
      return query(StructureSelectionQueries.ligand)
    case 'water':
      return query(StructureSelectionQueries.water)
    case 'ion':
      return query(StructureSelectionQueries.ion)
    case 'chain':
      return { elements: { auth_asym_id: selector.chain } }
    case 'residue': {
      const field = selector.auth === false ? 'label_seq_id' : 'auth_seq_id'
      return {
        elements: {
          ...(selector.chain === undefined ? {} : { auth_asym_id: selector.chain }),
          [field]: selector.index,
        } as ElementSchema,
      }
    }
    case 'residues': {
      const prefix = selector.auth === false ? 'label_seq_id' : 'auth_seq_id'
      return {
        elements: {
          ...(selector.chain === undefined ? {} : { auth_asym_id: selector.chain }),
          [`beg_${prefix}`]: selector.start,
          [`end_${prefix}`]: selector.end,
        } as ElementSchema,
      }
    }
    case 'comp':
      return { elements: { label_comp_id: selector.compId } }
    case 'schema':
      return { elements: selector.schema }
  }
}

/** A schema-only selector, or undefined when the selector needs a full query. */
export function selectorSchema(selector: StructureSelector): ElementSchema | undefined {
  const compiled = compileSelector(selector)
  return 'elements' in compiled ? compiled.elements : undefined
}

/** The Mol* expression equivalent of a selector, for direct Loci lookups. */
export function selectorExpression(selector: StructureSelector): Expression {
  const compiled = compileSelector(selector)
  return 'elements' in compiled
    ? StructureElement.Schema.toExpression(compiled.elements)
    : compiled.expression(undefined)
}

/**
 * Stable component key for one selection.
 *
 * Repeated targeted styles of the same selection reuse one Mol* cell; each
 * `replace: false` command adds its own representation there, so cartoon +
 * stick + line overlays do not fragment into sibling components.
 */
export function selectionKey(selector: StructureSelector): string {
  let hash = 2166136261
  for (const char of JSON.stringify(selector)) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return `mol4agent-sel-${(hash >>> 0).toString(36)}`
}

/** Short human label for a selector, used in tool and inspection output. */
export function describeSelector(selector: StructureSelector): string {
  switch (selector.kind) {
    case 'all': return 'whole structure'
    case 'polymer': return 'polymer'
    case 'protein': return 'protein'
    case 'nucleic': return 'nucleic acid'
    case 'ligand': return 'ligand'
    case 'water': return 'water'
    case 'ion': return 'ion'
    case 'chain': return `chain ${selector.chain}`
    case 'residue': return `residue ${selector.chain ?? ''}${selector.index}`
    case 'residues': return `residues ${selector.chain ?? ''}${selector.start}-${selector.end}`
    case 'comp': return `comp ${selector.compId}`
    case 'schema': return 'custom schema'
  }
}

function query(selection: { readonly expression: Expression }): CompiledSelector {
  return { expression: () => selection.expression }
}
