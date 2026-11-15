import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { summarizeStructure } from '../src/parse/index.ts'

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../../../fixtures/${name}`, import.meta.url)))

test('summarizes the real fixtures with stable counts', () => {
  const crn = summarizeStructure({ data: fixture('1crn.pdb'), format: 'pdb', label: '1crn.pdb' })
  assert.equal(crn.format, 'pdb')
  assert.equal(crn.atomCount, 327)
  assert.equal(crn.residueCount, 46)
  assert.equal(crn.modelCount, 1)
  assert.equal(crn.chains.length, 1)
  assert.equal(crn.complete, true)

  const crnCif = summarizeStructure({ data: fixture('1crn.cif'), format: 'mmcif', label: '1crn.cif' })
  assert.equal(crnCif.format, 'mmcif')
  assert.equal(crnCif.atomCount, 327)
  assert.equal(crnCif.residueCount, 46)

  const atp = summarizeStructure({ data: fixture('1atp.pdb'), format: 'pdb', label: '1atp.pdb' })
  assert.equal(atp.atomCount, 3070)
  assert.equal(atp.residueCount, 462)
  assert.equal(atp.chains.length, 2)

  const czd = summarizeStructure({ data: fixture('7czd.pdb'), format: 'pdb', label: '7czd.pdb' })
  assert.equal(czd.atomCount, 4266)
  assert.equal(czd.residueCount, 1056)
  assert.equal(czd.chains.length, 4)

  const aspirin = summarizeStructure({ data: fixture('aspirin.sdf'), format: 'sdf', label: 'aspirin.sdf' })
  assert.equal(aspirin.format, 'sdf')
  assert.equal(aspirin.atomCount, 21)
  assert.equal(aspirin.residueCount, 1)
})

test('counts distinct models in multi-model PDB and mmCIF', () => {
  const atom = 'ATOM      1  CA  ALA A   1       0.000   0.000   0.000  1.00  0.00           C'
  const pdb = `MODEL        1\n${atom}\nENDMDL\nMODEL        3\n${atom}\nENDMDL\n`
  const pdbSummary = summarizeStructure({ data: pdb, format: 'pdb' })
  assert.equal(pdbSummary.modelCount, 2)

  const cif = `data_test\n#\nloop_\n_atom_site.group_PDB\n_atom_site.label_comp_id\n_atom_site.auth_asym_id\n_atom_site.auth_seq_id\n_atom_site.pdbx_PDB_model_num\nATOM ALA A 1 1\nATOM ALA A 1 2\n#\n`
  const cifSummary = summarizeStructure({ data: cif, format: 'mmcif' })
  assert.equal(cifSummary.modelCount, 2)
})

test('BCIF reports an explicit unsupported summary', () => {
  assert.throws(
    () => summarizeStructure({ data: new Uint8Array([0, 1, 2]), format: 'bcif' }),
    (error: unknown) => (error as { code?: string }).code === 'SUMMARY_UNSUPPORTED',
  )
})
