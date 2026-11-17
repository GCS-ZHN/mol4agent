import assert from 'node:assert/strict'
import test from 'node:test'
import { formatResidueRanges, normalizeResidueRange, parseResidueRanges } from '../src/protocol.ts'
import { compileSelector, selectorSchema } from '../src/select.ts'

test('parses comma-separated residue segments', () => {
  assert.deepEqual(parseResidueRanges('1, 5-10, 20'), [
    { start: 1, end: 1 },
    { start: 5, end: 10 },
    { start: 20, end: 20 },
  ])
  assert.deepEqual(parseResidueRanges('7'), [{ start: 7, end: 7 }])
  assert.deepEqual(parseResidueRanges('-5--1'), [{ start: -5, end: -1 }])
})

test('sorts and merges overlapping or adjacent segments', () => {
  assert.deepEqual(parseResidueRanges('20, 5-10, 1'), [
    { start: 1, end: 1 },
    { start: 5, end: 10 },
    { start: 20, end: 20 },
  ])
  assert.deepEqual(parseResidueRanges('1-5, 3-8'), [{ start: 1, end: 8 }])
  assert.deepEqual(parseResidueRanges('5, 6, 7'), [{ start: 5, end: 7 }])
})

test('canonicalizes a range for token-efficient echoes', () => {
  assert.equal(normalizeResidueRange(' 1, 5 - 10, 20 '), '1,5-10,20')
  assert.equal(normalizeResidueRange('3, 1-2'), '1-3')
  assert.equal(formatResidueRanges([{ start: 4, end: 4 }, { start: 9, end: 12 }]), '4,9-12')
  assert.equal(formatResidueRanges([]), '')
})

test('rejects malformed residue ranges', () => {
  const cases: readonly [string, RegExp][] = [
    ['', /non-empty string/u],
    ['   ', /non-empty string/u],
    ['1,', /empty segment/u],
    ['nope', /invalid residue range segment/u],
    ['5-', /invalid residue range segment/u],
    ['1-2-3', /invalid residue range segment/u],
    ['10-5', /start must be <= end/u],
    ['99999999999999999999', /not an integer/u],
  ]
  for (const [range, expected] of cases) {
    assert.throws(() => parseResidueRanges(range), expected)
  }
})

test('compiles one contiguous range to a plain element schema', () => {
  assert.deepEqual(selectorSchema({ kind: 'residues', chain: 'A', range: '10-25' }), {
    auth_asym_id: 'A',
    beg_auth_seq_id: 10,
    end_auth_seq_id: 25,
  })
  assert.deepEqual(selectorSchema({ kind: 'residues', range: '4', auth: false }), {
    beg_label_seq_id: 4,
    end_label_seq_id: 4,
  })
})

test('compiles disjoint ranges to schema items Mol* unions', () => {
  assert.deepEqual(selectorSchema({ kind: 'residues', chain: 'B', range: '1, 5-10, 20' }), {
    items: [
      { auth_asym_id: 'B', beg_auth_seq_id: 1, end_auth_seq_id: 1 },
      { auth_asym_id: 'B', beg_auth_seq_id: 5, end_auth_seq_id: 10 },
      { auth_asym_id: 'B', beg_auth_seq_id: 20, end_auth_seq_id: 20 },
    ],
  })
})

test('semantic selectors do not compile to schemas', () => {
  assert.equal(selectorSchema({ kind: 'ligand' }), undefined)
  assert.deepEqual(compileSelector({ kind: 'chain', chain: 'C' }), { elements: { auth_asym_id: 'C' } })
})
