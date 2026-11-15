import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeCif } from '../src/parse/cif.ts'
import { summarizePdbLike } from '../src/parse/pdb.ts'
import { summarizeSdf } from '../src/parse/sdf.ts'
import { summarizeGro, summarizeMol2, summarizeXyz } from '../src/parse/small.ts'

const atomLine = 'ATOM      1  CA  ALA A   1       0.000   0.000   0.000  1.00  0.00           C'

test('PDB keeps altLoc A only, honors insertion codes, and reads TITLE', () => {
  const altB = atomLine.slice(0, 16) + 'B' + atomLine.slice(17)
  const altA = atomLine.slice(0, 16) + 'A' + atomLine.slice(17)
  const inserted = atomLine.slice(0, 26) + 'A' + atomLine.slice(27)
  const text = `TITLE     a small test\n${atomLine}\n${altA}\n${altB}\n${inserted}\n`
  const summary = summarizePdbLike(text, 'pdb', 'x.pdb')
  assert.equal(summary.title, 'a small test')
  assert.equal(summary.atomCount, 3)
  assert.equal(summary.residueCount, 2)
  assert.equal(summary.chains[0]?.id, 'A')
  assert.equal(summary.chains[0]?.kind, 'polymer')
})

test('PDB-like formats share the same summary path', () => {
  for (const format of ['pdb', 'pdbqt', 'pqr'] as const) {
    const summary = summarizePdbLike(`${atomLine}\n`, format)
    assert.equal(summary.format, format)
    assert.equal(summary.atomCount, 1)
  }
})

test('PDB ignores malformed atom rows and non-atom records', () => {
  const summary = summarizePdbLike(`HEADER    TEST\nREMARK    x\n${atomLine}\n`, 'pdb')
  assert.equal(summary.atomCount, 1)
})

test('mmCIF reads quoted titles/values, insertion codes, and models', () => {
  const text = [
    "data_test",
    "_struct.title 'A quoted title'",
    "loop_",
    "_atom_site.group_PDB",
    "_atom_site.label_comp_id",
    "_atom_site.auth_asym_id",
    "_atom_site.auth_seq_id",
    "_atom_site.pdbx_PDB_ins_code",
    "_atom_site.pdbx_PDB_model_num",
    "ATOM 'ALA' 'A' '1' 'A' '1'",
    "ATOM 'GLY' 'A' '2' '?' '2'",
    "HETATM 'ATP' 'B' '101' '.' '2'",
    "#",
  ].join('\n')
  const summary = summarizeCif(text, 'mmcif', 'x.cif')
  assert.equal(summary.title, 'A quoted title')
  assert.equal(summary.atomCount, 3)
  assert.equal(summary.residueCount, 3)
  assert.equal(summary.modelCount, 2)
  assert.deepEqual(summary.chains.map(chain => chain.id), ['A', 'B'])
  assert.deepEqual(summary.ligands, [{ compId: 'ATP', count: 1 }])
})

test('mmCIF without a usable atom_site loop produces an empty summary', () => {
  const summary = summarizeCif('data_test\n_struct.title test\n', 'mmcif')
  assert.equal(summary.atomCount, 0)
  assert.equal(summary.title, 'test')
})

test('SDF counts records and atoms; MOL shares the parser', () => {
  const records = [
    'first',
    '  test',
    '',
    '  2  1  0  0  0  0            999 V2000',
    '    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0',
    '    1.0000    0.0000    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0',
    '  1  2  1  0',
    '$$$$',
    'second',
    '',
    '  1  0  0  0  0  0            999 V2000',
    '    0.0000    0.0000    0.0000 N   0  0  0  0  0  0  0  0  0  0  0  0',
    '$$$$',
  ].join('\n')
  const sdf = summarizeSdf(records, 'sdf', 'x.sdf')
  assert.equal(sdf.modelCount, 2)
  assert.equal(sdf.atomCount, 3)
  assert.equal(sdf.residueCount, 2)
  assert.deepEqual(sdf.chains.map(chain => chain.id), ['1', '2'])
  assert.deepEqual(sdf.ligands, [{ compId: 'first', count: 1 }, { compId: 'second', count: 1 }])

  const mol = summarizeSdf('mol title\n  1  0  0  0  0  0            999 V2000\n', 'mol')
  assert.equal(mol.format, 'mol')
  assert.equal(mol.modelCount, 1)
  assert.equal(mol.atomCount, 1)
})

test('empty SDF has one model and no atoms', () => {
  const summary = summarizeSdf('', 'sdf')
  assert.equal(summary.atomCount, 0)
  assert.equal(summary.residueCount, 0)
  assert.equal(summary.modelCount, 1)
})

test('XYZ reads the declared count and comment', () => {
  const text = '3\nwater\nO 0 0 0\nH 1 0 0\nH 0 1 0\n'
  const summary = summarizeXyz(text, 'xyz', 'x.xyz')
  assert.equal(summary.title, 'water')
  assert.equal(summary.atomCount, 3)
  assert.equal(summary.chains[0]?.id, '_')
  assert.equal(summary.chains[0]?.kind, 'polymer')
})

test('GRO uses fixed residue columns and drops the box line', () => {
  const text = [
    'GRO test',
    '    2',
    '    1ALA     1   0.000   0.000   0.000',
    '    2GLY     2   1.000   0.000   0.000',
    '   1.000   1.000   1.000',
  ].join('\n')
  const summary = summarizeGro(text, 'gro', 'x.gro')
  assert.equal(summary.title, 'GRO test')
  assert.equal(summary.atomCount, 2)
  assert.equal(summary.chains[0]?.id, '_')
  assert.deepEqual(summary.chains[0]?.compIds, ['ALA', 'GLY'])
})

test('MOL2 reads the molecule title and ATOM section', () => {
  const text = [
    '@<TRIPOS>MOLECULE',
    'benzene',
    ' 6 6 0 0 0',
    '@<TRIPOS>ATOM',
    '1 C1 0.000 0.000 0.000 C.ar 1 BEN 0.0',
    '2 C2 1.000 0.000 0.000 C.ar 1 BEN 0.0',
  ].join('\n')
  const summary = summarizeMol2(text, 'mol2', 'x.mol2')
  assert.equal(summary.title, 'benzene')
  assert.equal(summary.atomCount, 2)
  assert.equal(summary.residueCount, 1)
  assert.equal(summary.chains[0]?.kind, 'ligand')
  assert.deepEqual(summary.ligands, [{ compId: 'BEN', count: 1 }])
})
