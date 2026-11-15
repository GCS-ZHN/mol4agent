/**
 * Runtime validation for the JSON selectors agents pass to `mol_select` and
 * friends. Core consumes the normalized value; this adapter guards the shape
 * before it becomes a scene command.
 *
 * @module @gcszhn/mol4agent-opencode/selector
 */
import type { StructureSelector } from '@gcszhn/mol4agent-core/protocol'

const KINDS = new Set([
  'all',
  'polymer',
  'protein',
  'nucleic',
  'ligand',
  'water',
  'ion',
  'chain',
  'residue',
  'residues',
  'comp',
  'schema',
])

/** Validate and normalize one selector. Throws a model-facing Error when malformed. */
export function normalizeSelector(value: unknown): StructureSelector {
  if (typeof value !== 'object' || value === null) {
    throw new Error('selector must be an object with a "kind" field')
  }
  const candidate = value as Record<string, unknown>
  const kind = candidate.kind
  if (typeof kind !== 'string' || !KINDS.has(kind)) {
    throw new Error(`selector "kind" must be one of: ${[...KINDS].join(', ')}`)
  }
  switch (kind) {
    case 'chain':
      return { kind, chain: requiredString(candidate.chain, 'chain') }
    case 'residue':
      return {
        kind,
        ...(candidate.chain === undefined ? {} : { chain: requiredString(candidate.chain, 'chain') }),
        index: requiredNumber(candidate.index, 'index'),
        ...(candidate.auth === undefined ? {} : { auth: candidate.auth === true }),
      }
    case 'residues':
      return {
        kind,
        ...(candidate.chain === undefined ? {} : { chain: requiredString(candidate.chain, 'chain') }),
        start: requiredNumber(candidate.start, 'start'),
        end: requiredNumber(candidate.end, 'end'),
        ...(candidate.auth === undefined ? {} : { auth: candidate.auth === true }),
      }
    case 'comp':
      return { kind, compId: requiredString(candidate.compId, 'compId') }
    case 'schema':
      if (typeof candidate.schema !== 'object' || candidate.schema === null) {
        throw new Error('"schema" selector needs a schema object')
      }
      return { kind, schema: candidate.schema as Record<string, string | number> }
    case 'all':
    case 'polymer':
    case 'protein':
    case 'nucleic':
    case 'ligand':
    case 'water':
    case 'ion':
      return { kind }
  }
  throw new Error(`unsupported selector kind "${kind}"`)
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`selector "${field}" must be a non-empty string`)
  return value
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`selector "${field}" must be a number`)
  return value
}
