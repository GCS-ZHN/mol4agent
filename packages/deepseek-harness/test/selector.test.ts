import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeSelector } from '../src/selector.ts'

test('normalizes every semantic selector', () => {
  for (const kind of ['all', 'polymer', 'protein', 'nucleic', 'ligand', 'water', 'ion'] as const) {
    assert.deepEqual(normalizeSelector({ kind }), { kind })
  }
})

test('normalizes structural selectors and auth switches', () => {
  assert.deepEqual(normalizeSelector({ kind: 'chain', chain: 'A' }), { kind: 'chain', chain: 'A' })
  assert.deepEqual(
    normalizeSelector({ kind: 'residue', chain: 'A', index: 42, auth: false }),
    { kind: 'residue', chain: 'A', index: 42, auth: false },
  )
  assert.deepEqual(
    normalizeSelector({ kind: 'residue', index: 42, auth: true }),
    { kind: 'residue', index: 42, auth: true },
  )
  assert.deepEqual(
    normalizeSelector({ kind: 'residues', chain: 'A', range: '10-25' }),
    { kind: 'residues', chain: 'A', range: '10-25' },
  )
  assert.deepEqual(
    normalizeSelector({ kind: 'residues', chain: 'A', range: ' 20, 5 - 10, 1 ' }),
    { kind: 'residues', chain: 'A', range: '1,5-10,20' },
  )
  assert.deepEqual(normalizeSelector({ kind: 'comp', compId: 'ATP' }), { kind: 'comp', compId: 'ATP' })
  assert.deepEqual(
    normalizeSelector({ kind: 'schema', schema: { label_comp_id: 'HEM' } }),
    { kind: 'schema', schema: { label_comp_id: 'HEM' } },
  )
})

test('rejects malformed selectors with model-actionable errors', () => {
  const cases: readonly [unknown, RegExp][] = [
    [null, /must be an object/],
    [{}, /kind/],
    [{ kind: 'unknown' }, /kind/],
    [{ kind: 'chain' }, /chain/],
    [{ kind: 'chain', chain: '' }, /chain/],
    [{ kind: 'residue', chain: 'A' }, /index/],
    [{ kind: 'residue', chain: 'A', index: Number.NaN }, /index/],
    [{ kind: 'residues', chain: 'A' }, /range/],
    [{ kind: 'residues', chain: 'A', range: '10-5' }, /start must be <= end/],
    [{ kind: 'residues', chain: 'A', start: 1, end: 9 }, /range/],
    [{ kind: 'comp' }, /compId/],
    [{ kind: 'schema' }, /schema/],
  ]
  for (const [value, expected] of cases) {
    assert.throws(() => normalizeSelector(value), expected)
  }
})
