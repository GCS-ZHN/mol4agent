import assert from 'node:assert/strict'
import test from 'node:test'
import { Mol4AgentError } from '../src/protocol.ts'
import {
  SOURCE_DATABASES,
  SOURCE_DATABASE_INFO,
  isSourceDatabase,
  normalizeSourceDb,
  readSourceIndexField,
  resolveSource,
  sourceDatabases,
} from '../src/sources.ts'

test('source table stays closed and defaults to rcsb-pdb', () => {
  assert.deepEqual([...SOURCE_DATABASES], [
    'rcsb-pdb',
    'rcsb-cif',
    'rcsb-bcif',
    'alphafold',
    'pubchem',
    'chembl',
  ])
  assert.deepEqual([...sourceDatabases()], [...SOURCE_DATABASES])
  assert.equal(normalizeSourceDb(undefined), 'rcsb-pdb')
  assert.equal(normalizeSourceDb(''), 'rcsb-pdb')
  assert.equal(normalizeSourceDb(' RCSB-CIF '), 'rcsb-cif')
  for (const sourceDb of SOURCE_DATABASES) {
    assert.equal(isSourceDatabase(sourceDb), true)
    assert.equal(SOURCE_DATABASE_INFO[sourceDb].format, resolveSource({
      entryId: sourceDb === 'alphafold' ? 'P00533' : sourceDb === 'pubchem' ? '2244' : sourceDb === 'chembl' ? '25' : '1crn',
      sourceDb,
    }).format)
  }
  assert.equal(isSourceDatabase('rcsb'), false)
})

test('rejects unknown sources with a structured error', () => {
  assert.throws(
    () => normalizeSourceDb('rcsb-pdb-old'),
    (error: unknown) => error instanceof Mol4AgentError
      && error.code === 'UNSUPPORTED_SOURCE'
      && error.message.includes('rcsb-pdb'),
  )
})

test('resolves RCSB entry ids in PDB, mmCIF, and BinaryCIF form', () => {
  assert.deepEqual(resolveSource({ entryId: '1crn' }), {
    sourceDb: 'rcsb-pdb',
    entryId: '1CRN',
    format: 'pdb',
    fileName: '1CRN.pdb',
    plan: { url: 'https://files.rcsb.org/download/1CRN.pdb' },
    description: 'RCSB PDB entry 1CRN (PDB format)',
  })
  assert.deepEqual(resolveSource({ entryId: ' 7czd ', sourceDb: 'rcsb-cif' }), {
    sourceDb: 'rcsb-cif',
    entryId: '7CZD',
    format: 'mmcif',
    fileName: '7CZD.cif',
    plan: { url: 'https://files.rcsb.org/download/7CZD.cif' },
    description: 'RCSB PDB entry 7CZD (mmCIF format)',
  })
  assert.deepEqual(resolveSource({ entryId: '1atp', sourceDb: 'rcsb-bcif' }).plan, {
    url: 'https://models.rcsb.org/1ATP.bcif',
  })
  assert.equal(resolveSource({ entryId: '1atp', sourceDb: 'rcsb-bcif' }).format, 'bcif')
})

test('rejects malformed PDB entry ids', () => {
  for (const entryId of ['', '  ', '1cr', '1crnn', 'abcd', '1crn.pdb', '1cr n']) {
    assert.throws(
      () => resolveSource({ entryId }),
      (error: unknown) => error instanceof Mol4AgentError && error.code === 'INVALID_ENTRY_ID',
      entryId,
    )
  }
})

test('resolves AlphaFold accessions through the versioned API index', () => {
  const source = resolveSource({ entryId: 'p00533', sourceDb: 'alphafold' })
  assert.deepEqual(source, {
    sourceDb: 'alphafold',
    entryId: 'P00533',
    format: 'pdb',
    fileName: 'AF-P00533-F1-model.pdb',
    plan: {
      url: 'https://alphafold.ebi.ac.uk/api/prediction/P00533',
      indexField: '0.pdbUrl',
    },
    description: 'AlphaFold DB prediction for UniProt P00533 (PDB format)',
  })
  assert.equal(resolveSource({ entryId: 'AF-P00533-F1', sourceDb: 'alphafold' }).entryId, 'P00533')
  assert.throws(
    () => resolveSource({ entryId: 'P0053', sourceDb: 'alphafold' }),
    (error: unknown) => error instanceof Mol4AgentError && error.code === 'INVALID_ENTRY_ID',
  )
})

test('resolves PubChem CIDs and names to 3D SDF downloads', () => {
  assert.deepEqual(resolveSource({ entryId: '2244', sourceDb: 'pubchem' }), {
    sourceDb: 'pubchem',
    entryId: '2244',
    format: 'sdf',
    fileName: 'pubchem-2244.sdf',
    plan: { url: 'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/2244/SDF?record_type=3d' },
    description: 'PubChem compound 2244 (3D SDF)',
  })
  assert.equal(resolveSource({ entryId: 'CID: 2244', sourceDb: 'pubchem' }).entryId, '2244')

  const named = resolveSource({ entryId: 'Acetylsalicylic acid', sourceDb: 'pubchem' })
  assert.equal(named.entryId, 'Acetylsalicylic acid')
  assert.equal(named.fileName, 'pubchem-acetylsalicylic-acid.sdf')
  assert.equal(
    named.plan.url,
    'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/Acetylsalicylic%20acid/SDF?record_type=3d',
  )
  assert.equal(resolveSource({ entryId: '///', sourceDb: 'pubchem' }).fileName, 'pubchem-compound.sdf')
  assert.throws(
    () => resolveSource({ entryId: 'x'.repeat(121), sourceDb: 'pubchem' }),
    (error: unknown) => error instanceof Mol4AgentError && error.code === 'INVALID_ENTRY_ID',
  )
  assert.throws(
    () => resolveSource({ entryId: 'asp\nirin', sourceDb: 'pubchem' }),
    (error: unknown) => error instanceof Mol4AgentError && error.code === 'INVALID_ENTRY_ID',
  )
})

test('resolves ChEMBL ids, accepting bare numbers', () => {
  assert.deepEqual(resolveSource({ entryId: 'chembl25', sourceDb: 'chembl' }), {
    sourceDb: 'chembl',
    entryId: 'CHEMBL25',
    format: 'sdf',
    fileName: 'CHEMBL25.sdf',
    plan: { url: 'https://www.ebi.ac.uk/chembl/api/data/molecule/CHEMBL25.sdf' },
    description: 'ChEMBL molecule CHEMBL25 (SDF)',
  })
  assert.equal(resolveSource({ entryId: '25', sourceDb: 'chembl' }).entryId, 'CHEMBL25')
  assert.throws(
    () => resolveSource({ entryId: 'CHEM25', sourceDb: 'chembl' }),
    (error: unknown) => error instanceof Mol4AgentError && error.code === 'INVALID_ENTRY_ID',
  )
})

test('reads a dot path from a JSON index document', () => {
  const payload = [{ pdbUrl: 'https://alphafold.ebi.ac.uk/files/AF-P00533-F1-model_v6.pdb', cifUrl: null }]
  assert.equal(readSourceIndexField(payload, '0.pdbUrl'), 'https://alphafold.ebi.ac.uk/files/AF-P00533-F1-model_v6.pdb')
  assert.equal(readSourceIndexField(payload, '0.cifUrl'), undefined)
  assert.equal(readSourceIndexField(payload, '1.pdbUrl'), undefined)
  assert.equal(readSourceIndexField(payload, '0.missing'), undefined)
  assert.equal(readSourceIndexField(payload, '0.pdbUrl.more'), undefined)
  assert.equal(readSourceIndexField({ a: { b: 42 } }, 'a.b'), undefined)
  assert.equal(readSourceIndexField(null, '0'), undefined)
})
