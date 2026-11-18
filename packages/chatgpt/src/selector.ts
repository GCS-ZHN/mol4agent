/**
 * Runtime validation for the JSON selectors agents pass to `mol_select` and
 * friends. Core consumes the normalized value; this adapter guards the shape
 * before it becomes a scene command or a resource read.
 *
 * @module @gcszhn/mol4agent-chatgpt/selector
 */
import { isStructureId, type StructureSelector } from '@gcszhn/mol4agent-core/protocol'

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

/**
 * Validate and normalize one selector.
 *
 * @throws Error with a model-facing reason for a malformed selector.
 */
export function normalizeSelector(value: unknown): StructureSelector {
  if (typeof value !== 'object' || value === null) {
    throw new Error('selector must be an object with a "kind" field')
  }
  const candidate = value as Record<string, unknown>
  const kind = candidate.kind
  if (typeof kind !== 'string' || !KINDS.has(kind)) {
    throw new Error(`selector "kind" must be one of: ${[...KINDS].join(', ')}`)
  }
  const scope = candidate.structureId === undefined
    ? {}
    : { structureId: requiredStructureId(candidate.structureId) }
  switch (kind) {
    case 'chain':
      return { kind, ...scope, chain: requiredString(candidate.chain, 'chain') }
    case 'residue':
      return {
        kind,
        ...scope,
        ...(candidate.chain === undefined ? {} : { chain: requiredString(candidate.chain, 'chain') }),
        index: requiredNumber(candidate.index, 'index'),
        ...(candidate.auth === undefined ? {} : { auth: candidate.auth === true }),
      }
    case 'residues':
      return {
        kind,
        ...scope,
        ...(candidate.chain === undefined ? {} : { chain: requiredString(candidate.chain, 'chain') }),
        start: requiredNumber(candidate.start, 'start'),
        end: requiredNumber(candidate.end, 'end'),
        ...(candidate.auth === undefined ? {} : { auth: candidate.auth === true }),
      }
    case 'comp':
      return { kind, ...scope, compId: requiredString(candidate.compId, 'compId') }
    case 'schema':
      if (typeof candidate.schema !== 'object' || candidate.schema === null) {
        throw new Error('"schema" selector needs a schema object')
      }
      return { kind, ...scope, schema: candidate.schema as Record<string, string | number> }
    case 'all':
    case 'polymer':
    case 'protein':
    case 'nucleic':
    case 'ligand':
    case 'water':
    case 'ion':
      return { kind, ...scope }
  }
  throw new Error(`unsupported selector kind "${kind}"`)
}

function requiredStructureId(value: unknown): string {
  if (!isStructureId(value)) {
    throw new Error(
      'selector "structureId" must start with a letter or digit and contain only letters, digits, ".", "_", or "-"',
    )
  }
  return value
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`selector "${field}" must be a non-empty string`)
  return value
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`selector "${field}" must be a number`)
  return value
}
