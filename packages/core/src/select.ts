/** Selector compilation: protocol selectors to Mol* schemas/queries. @module @gcszhn/mol4agent-core/select */
import { StructureSelectionQueries } from 'molstar/lib/mol-plugin-state/helpers/structure-selection-query.js'
import type { Expression } from 'molstar/lib/mol-script/language/expression.js'
import {
  parseResidueRanges,
  type ElementSchema,
  type StructureElementSchema,
  type StructureSelector,
} from './protocol.ts'

/** A selector compiled to the two shapes Mol*'s interactivity helper accepts. */
export type CompiledSelector =
  | { readonly elements: StructureElementSchema }
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
      const chain = selector.chain === undefined ? {} : { auth_asym_id: selector.chain }
      const items = parseResidueRanges(selector.range).map((range): ElementSchema => (
        selector.auth === false
          ? { ...chain, beg_label_seq_id: range.start, end_label_seq_id: range.end }
          : { ...chain, beg_auth_seq_id: range.start, end_auth_seq_id: range.end }
      ))
      // One segment stays a plain schema (measurement/label friendly); disjoint
      // segments become SchemaItems, which Mol* unions in toExpression/toLoci.
      return { elements: items.length === 1 ? items[0]! : { items } }
    }
    case 'comp':
      return { elements: { label_comp_id: selector.compId } }
    case 'schema':
      return { elements: selector.schema }
  }
}

/** A schema-only selector, or undefined when the selector needs a full query. */
export function selectorSchema(selector: StructureSelector): StructureElementSchema | undefined {
  const compiled = compileSelector(selector)
  return 'elements' in compiled ? compiled.elements : undefined
}

function query(selection: { readonly expression: Expression }): CompiledSelector {
  return { expression: () => selection.expression }
}
