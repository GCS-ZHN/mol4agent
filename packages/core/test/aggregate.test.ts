import assert from 'node:assert/strict'
import test from 'node:test'
import { SummaryBuilder, isIonCompId, isWaterCompId } from '../src/parse/aggregate.ts'

test('classifies chains, ligands, water, and ions', () => {
  const builder = new SummaryBuilder()
  builder.setTitle('Test structure')
  builder.atom({ record: 'atom', compId: 'ALA', chainId: 'A', seqId: '1' }, 1)
  builder.atom({ record: 'atom', compId: 'ALA', chainId: 'A', seqId: '2' }, 1)
  builder.atom({ record: 'hetatm', compId: 'ATP', chainId: 'B', seqId: '101' }, 1)
  builder.atom({ record: 'hetatm', compId: 'ATP', chainId: 'B', seqId: '102' }, 1)
  builder.atom({ record: 'hetatm', compId: 'HOH', chainId: 'W', seqId: '1' }, 1)
  builder.atom({ record: 'hetatm', compId: 'ZN', chainId: 'Z', seqId: '1' }, 1)
  builder.atom({ record: 'hetatm', compId: 'UNK', chainId: '', seqId: '1' }, 1)

  const summary = builder.finish('pdb', 'x.pdb')
  assert.equal(summary.title, 'Test structure')
  assert.equal(summary.atomCount, 7)
  assert.equal(summary.residueCount, 7)
  assert.equal(summary.modelCount, 1)
  assert.deepEqual(summary.chains.map(chain => [chain.id, chain.kind]), [
    ['_', 'ligand'],
    ['A', 'polymer'],
    ['B', 'ligand'],
    ['W', 'water'],
    ['Z', 'ion'],
  ])
  assert.deepEqual(summary.ligands, [
    { compId: 'ATP', count: 2 },
    { compId: 'UNK', count: 1 },
  ])
  assert.equal(isWaterCompId('WAT'), true)
  assert.equal(isWaterCompId('ATP'), false)
  assert.equal(isIonCompId('ZN'), true)
  assert.equal(isIonCompId('ATP'), false)
})

test('model count override and comp-id truncation are deterministic', () => {
  const builder = new SummaryBuilder()
  for (let i = 1; i <= 14; i += 1) {
    builder.atom({ record: 'atom', compId: `C${String(i).padStart(2, '0')}`, chainId: 'A', seqId: String(i) })
  }
  builder.setModelCount(3)
  const summary = builder.finish('mmcif')
  assert.equal(summary.modelCount, 3)
  assert.equal(summary.chains[0]?.atoms, 14)
  assert.equal(summary.chains[0]?.compIds.length, 12)
  assert.deepEqual(summary.chains[0]?.compIds, [
    'C01', 'C02', 'C03', 'C04', 'C05', 'C06',
    'C07', 'C08', 'C09', 'C10', 'C11', 'C12',
  ])
})

test('empty builder has a complete, zeroed summary', () => {
  const summary = new SummaryBuilder().finish('xyz')
  assert.equal(summary.atomCount, 0)
  assert.equal(summary.residueCount, 0)
  assert.equal(summary.modelCount, 1)
  assert.deepEqual(summary.chains, [])
  assert.deepEqual(summary.ligands, [])
  assert.equal(summary.complete, true)
})
