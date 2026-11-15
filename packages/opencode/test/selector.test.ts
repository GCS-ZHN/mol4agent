import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeSelector } from '../src/selector.ts'

test('semantic kinds pass through', () => {
  for (const kind of ['all', 'polymer', 'protein', 'nucleic', 'ligand', 'water', 'ion']) {
    assert.deepEqual(normalizeSelector({ kind }), { kind })
  }
})

test('keyed kinds normalize', () => {
  assert.deepEqual(normalizeSelector({ kind: 'chain', chain: 'A' }), { kind: 'chain', chain: 'A' })
  assert.deepEqual(normalizeSelector({ kind: 'residue', index: 42 }), { kind: 'residue', index: 42 })
  assert.deepEqual(normalizeSelector({ kind: 'residues', start: 1, end: 2 }), { kind: 'residues', start: 1, end: 2 })
  assert.deepEqual(normalizeSelector({ kind: 'comp', compId: 'ATP' }), { kind: 'comp', compId: 'ATP' })
  assert.deepEqual(normalizeSelector({ kind: 'schema', schema: { auth_asym_id: 'A' } }), { kind: 'schema', schema: { auth_asym_id: 'A' } })
})

test('auth is passed through', () => {
  assert.deepEqual(normalizeSelector({ kind: 'residue', index: 42, auth: true }), { kind: 'residue', index: 42, auth: true })
})

test('malformed selectors throw', () => {
  assert.throws(() => normalizeSelector(null))
  assert.throws(() => normalizeSelector({ kind: 'nope' }))
  assert.throws(() => normalizeSelector({ kind: 'chain' }))
  assert.throws(() => normalizeSelector({ kind: 'chain', chain: '' }))
  assert.throws(() => normalizeSelector({ kind: 'residue', index: 'x' }))
  assert.throws(() => normalizeSelector({ kind: 'schema' }))
})
