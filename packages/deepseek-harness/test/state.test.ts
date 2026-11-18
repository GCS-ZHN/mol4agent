import assert from 'node:assert/strict'
import test from 'node:test'
import { nextStructureId, resolveAddStructureId, structuresOfScene, type MolSceneState } from '../src/state.ts'

function tab(overrides: Partial<MolSceneState> = {}): MolSceneState {
  return {
    sceneKey: 'a',
    path: '/a.pdb',
    format: 'pdb',
    label: 'a.pdb',
    commands: [],
    ...overrides,
  }
}

test('structuresOfScene falls back to the primary structure', () => {
  const structures = structuresOfScene(tab())
  assert.deepEqual(structures.map(structure => structure.id), ['structure'])
})

test('add-id resolution trusts the entry folded for this call', () => {
  const scene = tab({
    structures: [
      { id: 'structure', path: '/a.pdb', format: 'pdb', label: 'a.pdb', callId: 'open' },
      { id: 'target', path: '/b.pdb', format: 'pdb', label: 'b.pdb', callId: 'add-target' },
    ],
  })
  const resolved = resolveAddStructureId(scene, 'add-target', 'target')
  assert.equal(resolved.id, 'target')
})

test('add-id resolution rejects a real duplicate and invalid ids', () => {
  const scene = tab({
    structures: [
      { id: 'structure', path: '/a.pdb', format: 'pdb', label: 'a.pdb' },
      { id: 'target', path: '/b.pdb', format: 'pdb', label: 'b.pdb', callId: 'previous-add' },
    ],
  })
  const duplicate = resolveAddStructureId(scene, 'new-call', 'target')
  assert.match(duplicate.error ?? '', /already loaded/u)
  const invalid = resolveAddStructureId(scene, 'new-call', 'bad id')
  assert.match(invalid.error ?? '', /invalid structure id/u)
  const generated = resolveAddStructureId(scene, 'new-call', undefined)
  assert.equal(generated.id, 'structure-2')
})

test('nextStructureId skips every occupied default id', () => {
  assert.equal(nextStructureId([{ id: 'structure' }]), 'structure-2')
  assert.equal(nextStructureId([{ id: 'structure' }, { id: 'structure-2' }]), 'structure-3')
  assert.equal(nextStructureId([{ id: 'custom' }, { id: 'structure-3' }]), 'structure-2')
})
