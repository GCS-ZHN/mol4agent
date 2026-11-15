import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { summarizeStructure } from '../src/parse/index.ts'

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../../../fixtures/formats/${name}`, import.meta.url)))

const pdbLike = [
  ['1crn.pdb', 'pdb'],
  ['1crn.ent', 'pdb'],
  ['1crn.pdbqt', 'pdbqt'],
  ['1crn.pqr', 'pqr'],
] as const

test('summarizes every PDB-like fixture and alias', () => {
  for (const [name, format] of pdbLike) {
    const summary = summarizeStructure({ data: fixture(name), format, label: name })
    assert.equal(summary.format, format, name)
    assert.equal(summary.atomCount, 327, name)
    assert.equal(summary.residueCount, 46, name)
    assert.equal(summary.chains.length, 1, name)
  }
})

test('summarizes every mmCIF fixture and alias', () => {
  for (const name of ['1crn.cif', '1crn.mmcif', '1crn.mcif']) {
    const summary = summarizeStructure({ data: fixture(name), format: 'mmcif', label: name })
    assert.equal(summary.format, 'mmcif', name)
    assert.equal(summary.atomCount, 327, name)
    assert.equal(summary.residueCount, 46, name)
  }
})

test('keeps BCIF as a renderable but unsupported-from-summary fixture', () => {
  const data = fixture('1crn.bcif')
  assert.equal(data[0], 0x83)
  assert.throws(
    () => summarizeStructure({ data, format: 'bcif' }),
    (error: unknown) => (error as { code?: string }).code === 'SUMMARY_UNSUPPORTED',
  )
})

test('summarizes MOL/SDF fixtures and aliases', () => {
  for (const [name, format] of [['aspirin.mol', 'mol'], ['aspirin.sdf', 'sdf'], ['aspirin.sd', 'sdf']] as const) {
    const summary = summarizeStructure({ data: fixture(name), format, label: name })
    assert.equal(summary.format, format, name)
    assert.equal(summary.atomCount, 21, name)
    assert.equal(summary.residueCount, 1, name)
    assert.equal(summary.modelCount, 1, name)
  }
})

test('summarizes MOL2, XYZ, and GRO fixtures', () => {
  const mol2 = summarizeStructure({ data: fixture('water.mol2'), format: 'mol2', label: 'water.mol2' })
  assert.equal(mol2.format, 'mol2')
  assert.equal(mol2.atomCount, 3)
  assert.equal(mol2.title, 'water')
  assert.equal(mol2.chains[0]?.kind, 'water')
  assert.deepEqual(mol2.ligands, [])

  const xyz = summarizeStructure({ data: fixture('water.xyz'), format: 'xyz', label: 'water.xyz' })
  assert.equal(xyz.format, 'xyz')
  assert.equal(xyz.atomCount, 3)
  assert.equal(xyz.title, 'water')

  const gro = summarizeStructure({ data: fixture('water.gro'), format: 'gro', label: 'water.gro' })
  assert.equal(gro.format, 'gro')
  assert.equal(gro.atomCount, 3)
  assert.equal(gro.title, 'water')
})
