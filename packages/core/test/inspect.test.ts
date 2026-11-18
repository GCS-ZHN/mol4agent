import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildInspectResult,
  centroid,
  countCompIds,
  kindOfEntity,
  listsResidues,
  type ResidueRecord,
} from '../src/inspect.ts'
import { DEFAULT_INSPECT_LIMIT, type InspectAtom } from '../src/protocol.ts'

function atom(name: string, x: number, y: number, z: number): InspectAtom {
  return { name, element: name.slice(0, 1), x, y, z }
}

function residue(overrides: Partial<ResidueRecord> & { readonly compId: string }): ResidueRecord {
  return {
    chain: 'A',
    seqId: 1,
    labelSeqId: 1,
    kind: 'polymer',
    center: { x: 0, y: 0, z: 0 },
    atoms: [atom('CA', 0, 0, 0)],
    ...overrides,
  }
}

const records: readonly ResidueRecord[] = [
  residue({ compId: 'ALA', seqId: 2, labelSeqId: 2, atoms: [atom('CA', 1, 2, 3), atom('CB', 4, 5, 6)] }),
  residue({ compId: 'HOH', seqId: 301, kind: 'water', atoms: [atom('O', 7.1234, 8, 9)] }),
  residue({ compId: 'CYS', seqId: 1, labelSeqId: 1, atoms: [atom('SG', -1, -2, -3)] }),
  residue({ compId: 'HOH', seqId: 302, kind: 'water', atoms: [atom('O', 10, 11, 12)] }),
]

test('classifies residues from entity type and subtype', () => {
  // Mol* reports water and ions as `non-polymer` entities; only the subtype
  // separates an ion from a ligand, matching the official "Ion" query.
  assert.equal(kindOfEntity('water', undefined), 'water')
  assert.equal(kindOfEntity('non-polymer', 'ion'), 'ion')
  assert.equal(kindOfEntity('non-polymer', undefined), 'ligand')
  assert.equal(kindOfEntity('polymer', 'peptide linking'), 'polymer')
  assert.equal(kindOfEntity('branched', undefined), 'polymer')
  assert.equal(kindOfEntity('macrolide', undefined), 'polymer')
  assert.equal(kindOfEntity(undefined, undefined), 'other')
})

test('centroid averages positions and survives an empty list', () => {
  assert.deepEqual(centroid([{ x: 0, y: 0, z: 0 }, { x: 2, y: 4, z: 6 }]), { x: 1, y: 2, z: 3 })
  assert.deepEqual(centroid([]), { x: 0, y: 0, z: 0 })
})

test('counts merge component ids and list solvent first', () => {
  assert.deepEqual(countCompIds(records), [
    { compId: 'HOH', kind: 'water', residues: 2, atoms: 2 },
    { compId: 'ALA', kind: 'polymer', residues: 1, atoms: 2 },
    { compId: 'CYS', kind: 'polymer', residues: 1, atoms: 1 },
  ])
})

test('summary reports totals, counts, and styles without rows', () => {
  const result = buildInspectResult({
    target: 'whole structure',
    detail: 'summary',
    chains: ['A'],
    models: 1,
    records,
    styles: [{ component: 'Structure', type: 'cartoon', color: 'chain-id', size: 'physical', colorValue: '#00ff00' }],
  })
  assert.equal(result.target, 'whole structure')
  assert.equal(result.residues, 4)
  assert.equal(result.atoms, 5)
  assert.equal(result.chains, 1)
  assert.equal(result.models, 1)
  assert.deepEqual(result.counts, [
    { compId: 'HOH', kind: 'water', residues: 2, atoms: 2 },
    { compId: 'ALA', kind: 'polymer', residues: 1, atoms: 2 },
    { compId: 'CYS', kind: 'polymer', residues: 1, atoms: 1 },
  ])
  assert.equal(result.residueRows, undefined)
  assert.equal(result.truncated, false)
  assert.deepEqual(result.styles, [
    { component: 'Structure', type: 'cartoon', color: 'chain-id', size: 'physical', colorValue: '#00ff00' },
  ])
})

test('counts answer "how many waters" even for the summary detail', () => {
  const result = buildInspectResult({
    target: 'whole structure',
    detail: 'summary',
    chains: ['A'],
    models: 1,
    records,
    styles: [],
  })
  assert.equal(result.residueRows, undefined)
  const water = result.counts.find(row => row.compId === 'HOH')
  assert.deepEqual(water, { compId: 'HOH', kind: 'water', residues: 2, atoms: 2 })
  assert.equal(listsResidues('summary'), false)
  assert.equal(listsResidues('residues'), true)
  assert.equal(listsResidues('atoms'), true)
})

test('residue rows follow chain/sequence order and omit atoms', () => {
  const result = buildInspectResult({
    target: 'chain A',
    detail: 'residues',
    chains: ['A'],
    models: 1,
    records,
    styles: [],
  })
  assert.deepEqual(result.residueRows?.map(row => `${row.compId}${row.seqId}`), ['CYS1', 'ALA2', 'HOH301', 'HOH302'])
  assert.equal(result.residueRows?.[0]?.atomRows, undefined)
  assert.equal(result.residueRows?.[0]?.atoms, 1)
})

test('atoms detail keeps atom rows and rounds coordinates', () => {
  const result = buildInspectResult({
    target: 'residue A301',
    detail: 'atoms',
    chains: ['A'],
    models: 1,
    records: [records[1]!],
    styles: [],
  })
  const row = result.residueRows?.[0]
  assert.equal(row?.compId, 'HOH')
  assert.deepEqual(row?.atomRows, [{ name: 'O', element: 'O', x: 7.123, y: 8, z: 9 }])
})

test('the row budget truncates rows but never the totals or counts', () => {
  // A limit that leaves rows out must still report complete totals.
  const rows = buildInspectResult({
    target: 'whole structure',
    detail: 'residues',
    chains: ['A'],
    models: 1,
    records,
    styles: [],
    limit: 2,
  })
  assert.equal(rows.residueRows?.length, 2)
  assert.equal(rows.residues, 4)
  assert.equal(rows.atoms, 5)
  assert.equal(rows.truncated, true)
  assert.equal(rows.counts.find(row => row.compId === 'HOH')?.residues, 2, 'counts stay complete')
})

test('a nonsense budget falls back to the default instead of an empty result', () => {
  const zero = buildInspectResult({
    target: 'whole structure',
    detail: 'residues',
    chains: ['A'],
    models: 1,
    records,
    styles: [],
    limit: 0,
  })
  assert.equal(zero.residueRows?.length, 1)
  assert.equal(zero.truncated, true)

  const huge = buildInspectResult({
    target: 'whole structure',
    detail: 'residues',
    chains: ['A'],
    models: 1,
    records: Array.from({ length: DEFAULT_INSPECT_LIMIT + 5 }, (_, index) =>
      residue({ compId: 'ALA', seqId: index + 1 })),
    styles: [],
    limit: Number.NaN,
  })
  assert.equal(huge.residueRows?.length, DEFAULT_INSPECT_LIMIT)
  assert.equal(huge.truncated, true)
})

test('selection and focus totals are carried through as given', () => {
  const result = buildInspectResult({
    target: 'whole structure',
    detail: 'summary',
    chains: ['A'],
    models: 1,
    records,
    styles: [],
    selection: { entries: 1, atoms: 2, residues: 1 },
    focus: { entries: 1, atoms: 1, residues: 1 },
  })
  assert.deepEqual(result.selection, { entries: 1, atoms: 2, residues: 1 })
  assert.deepEqual(result.focus, { entries: 1, atoms: 1, residues: 1 })
})
