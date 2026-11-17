import assert from 'node:assert/strict'
import test from 'node:test'
import 'molstar/lib/mol-script/runtime/query/table.js'
import { OrderedSet } from 'molstar/lib/mol-data/int.js'
import { parsePDB } from 'molstar/lib/mol-io/reader/pdb/parser.js'
import { trajectoryFromPDB } from 'molstar/lib/mol-model-formats/structure/pdb.js'
import { Structure, StructureElement, StructureProperties } from 'molstar/lib/mol-model/structure.js'
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
    ['100A', /invalid residue range segment/u],
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

test('passes insertion-code and residue-index schema fields through', () => {
  assert.deepEqual(
    selectorSchema({
      kind: 'schema',
      schema: { auth_asym_id: 'H', auth_seq_id: 100, pdbx_PDB_ins_code: 'A' },
    }),
    { auth_asym_id: 'H', auth_seq_id: 100, pdbx_PDB_ins_code: 'A' },
  )
  assert.deepEqual(
    selectorSchema({ kind: 'schema', schema: { auth_asym_id: 'H', residue_index: 42 } }),
    { auth_asym_id: 'H', residue_index: 42 },
  )
})

function pdbAtom(serial: number, seq: number, insCode: string, x: number): string {
  return 'ATOM  '
    + String(serial).padStart(5) + ' '
    + ' CA '
    + ' ' + 'ALA' + ' '
    + 'A'
    + String(seq).padStart(4)
    + (insCode === '' ? ' ' : insCode)
    + '   '
    + x.toFixed(3).padStart(8)
    + '   0.000   0.000  1.00  0.00          ' + ' C'
}

/** Residues 1, 1A, 1B, 2, 4: insertion codes share number 1; residue 3 is missing. */
async function loadInsertionCodeFixture() {
  const pdb = [
    pdbAtom(1, 1, '', 0),
    pdbAtom(2, 1, 'A', 4),
    pdbAtom(3, 1, 'B', 8),
    pdbAtom(4, 2, '', 12),
    pdbAtom(5, 4, '', 16),
    'END',
  ].join('\n')
  const parsed = await parsePDB(pdb).run()
  const trajectory = await trajectoryFromPDB(parsed.result).run()
  return Structure.ofModel(trajectory.representative)
}

function residueLabels(structure: Structure, elements: Parameters<typeof StructureElement.Loci.fromSchema>[1]): string[] {
  const loci = StructureElement.Loci.fromSchema(structure, elements)
  const residues = new Map<number, string>()
  for (const element of loci.elements) {
    OrderedSet.forEach(element.indices, index => {
      const location = StructureElement.Location.create(structure, element.unit, element.unit.elements[index])
      const auth = StructureProperties.residue.auth_seq_id(location)
      const ins = StructureProperties.residue.pdbx_PDB_ins_code(location)
      residues.set(StructureProperties.residue.key(location), `${String(auth)}${ins}`)
    })
  }
  return [...residues.values()].sort()
}

test('engine: range intervals cover all insertion codes but not missing residues', async () => {
  const structure = await loadInsertionCodeFixture()
  const select = (selector: unknown): string[] => {
    const elements = selectorSchema(selector as never)
    assert.ok(elements !== undefined)
    return residueLabels(structure, elements)
  }

  // 1, 1A and 1B all have auth_seq_id 1, exactly like Mol*'s beg/end predicate.
  assert.deepEqual(select({ kind: 'residues', chain: 'A', range: '1' }), ['1', '1A', '1B'])
  assert.deepEqual(select({ kind: 'residues', chain: 'A', range: '1-2' }), ['1', '1A', '1B', '2'])
  assert.deepEqual(select({ kind: 'residues', chain: 'A', range: '1, 4' }), ['1', '1A', '1B', '4'])
  // A numeric interval spanning a gap selects only present residues.
  assert.deepEqual(select({ kind: 'residues', chain: 'A', range: '1-4' }), ['1', '1A', '1B', '2', '4'])
  assert.deepEqual(select({ kind: 'residues', chain: 'A', range: '2-4' }), ['2', '4'])
  // A number that is not present matches nothing; ranges do not invent residues.
  assert.deepEqual(select({ kind: 'residues', chain: 'A', range: '3' }), [])
  // Label numbering is a distinct namespace: with insertion codes it is a linear serial.
  assert.deepEqual(select({ kind: 'residues', chain: 'A', range: '1', auth: false }), ['1'])
})

test('engine: schema insertion code and residue index select one residue exactly', async () => {
  const structure = await loadInsertionCodeFixture()
  const select = (schema: Record<string, string | number>): string[] => {
    const elements = selectorSchema({ kind: 'schema', schema } as never)
    assert.ok(elements !== undefined)
    return residueLabels(structure, elements)
  }

  assert.deepEqual(select({ auth_asym_id: 'A', auth_seq_id: 1, pdbx_PDB_ins_code: '' }), ['1'])
  assert.deepEqual(select({ auth_asym_id: 'A', auth_seq_id: 1, pdbx_PDB_ins_code: 'A' }), ['1A'])
  assert.deepEqual(select({ auth_asym_id: 'A', auth_seq_id: 1, pdbx_PDB_ins_code: 'B' }), ['1B'])
  assert.deepEqual(select({ auth_asym_id: 'A', residue_index: 1 }), ['1A'])
})
