/**
 * Runtime validation for the JSON selectors agents pass to `mol_select` and
 * friends. Core consumes the normalized value; this adapter only guards the
 * shape before it is written into the session projection.
 *
 * @module @gcszhn/mol4agent-deepseekharness/selector
 */
import { normalizeResidueRange, type StructureSelector } from '@gcszhn/mol4agent-core/protocol'

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
 * Top-level fields each selector kind accepts. Fields are exclusive to their
 * kind: a `schema` predicate is not merged into `residues.range`, so passing
 * both is rejected instead of silently dropping one.
 */
const ALLOWED_FIELDS: Record<StructureSelector['kind'], readonly string[]> = {
  all: ['kind'],
  polymer: ['kind'],
  protein: ['kind'],
  nucleic: ['kind'],
  ligand: ['kind'],
  water: ['kind'],
  ion: ['kind'],
  chain: ['kind', 'chain'],
  residue: ['kind', 'chain', 'index', 'auth'],
  residues: ['kind', 'chain', 'range', 'auth'],
  comp: ['kind', 'compId'],
  schema: ['kind', 'schema'],
}

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
  assertFields(kind as StructureSelector['kind'], candidate)
  switch (kind) {
    case 'chain':
      return { kind, chain: requiredString(candidate.chain, 'chain') }
    case 'residue': {
      const auth = optionalBoolean(candidate.auth, 'auth')
      return {
        kind,
        ...(candidate.chain === undefined ? {} : { chain: requiredString(candidate.chain, 'chain') }),
        index: requiredNumber(candidate.index, 'index'),
        ...(auth === undefined ? {} : { auth }),
      }
    }
    case 'residues': {
      const auth = optionalBoolean(candidate.auth, 'auth')
      return {
        kind,
        ...(candidate.chain === undefined ? {} : { chain: requiredString(candidate.chain, 'chain') }),
        range: normalizeResidueRange(requiredString(candidate.range, 'range')),
        ...(auth === undefined ? {} : { auth }),
      }
    }
    case 'comp':
      return { kind, compId: requiredString(candidate.compId, 'compId') }
    case 'schema':
      if (typeof candidate.schema !== 'object' || candidate.schema === null || Array.isArray(candidate.schema)) {
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

function assertFields(kind: StructureSelector['kind'], candidate: Record<string, unknown>): void {
  const allowed = ALLOWED_FIELDS[kind]
  const extra = Object.keys(candidate).filter(key => !allowed.includes(key))
  if (extra.length === 0) return
  const fields = extra.map(key => `"${key}"`).join(', ')
  const hint = extra.includes('schema')
    ? '; "schema" is a separate selector kind: {"kind":"schema","schema":{...}}'
    : ''
  throw new Error(
    `selector kind "${kind}" does not accept ${extra.length === 1 ? 'field' : 'fields'} ${fields}`
    + ` (allowed: ${allowed.join(', ')})${hint}`,
  )
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`selector "${field}" must be a non-empty string`)
  return value
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`selector "${field}" must be a number`)
  return value
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`selector "${field}" must be a boolean`)
  return value
}
