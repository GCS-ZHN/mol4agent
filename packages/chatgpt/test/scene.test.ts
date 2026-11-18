import assert from 'node:assert/strict'
import { test } from 'node:test'
import { activeStructures, nextStructureId, SceneStore } from '../src/scene.ts'

function openStore(): { store: SceneStore; sceneId: string } {
  const store = new SceneStore()
  const scene = store.openAgent({
    path: '/tmp/a.pdb',
    label: 'a.pdb',
    format: 'pdb',
    bytes: new Uint8Array(),
    commands: [],
  })
  return { store, sceneId: scene.sceneId }
}

test('a scene starts with the primary structure and can add another', () => {
  const { store, sceneId } = openStore()
  const first = store.snapshotAgent()
  assert.deepEqual(first?.structures.map(structure => structure.id), ['structure'])

  const added = store.addAgentStructure({
    id: 'target',
    path: '/tmp/b.pdb',
    label: 'b.pdb',
    format: 'pdb',
    bytes: new Uint8Array(),
  })
  assert.deepEqual(added?.structures.map(structure => structure.id), ['structure', 'target'])
  assert.equal(store.structure(sceneId, 'target')?.label, 'b.pdb')
  assert.equal(store.structure(sceneId)?.id, 'structure')

  assert.throws(() => store.addAgentStructure({
    id: 'target',
    path: '/tmp/c.pdb',
    label: 'c.pdb',
    format: 'pdb',
    bytes: new Uint8Array(),
  }), /already used/)
})

test('removed structures leave the replay log and the active list', () => {
  const { store } = openStore()
  store.addAgentStructure({
    id: 'target',
    path: '/tmp/b.pdb',
    label: 'b.pdb',
    format: 'pdb',
    bytes: new Uint8Array(),
  })
  const next = store.pushAgent({ op: 'remove-structure', structureId: 'target' })
  assert.ok(next)
  assert.deepEqual(next.structures.map(structure => structure.id), ['structure', 'target'])
  assert.deepEqual(activeStructures(next).map(structure => structure.id), ['structure'])
  assert.equal(next.commands.at(-1)?.op, 'remove-structure')
})

test('generated structure ids skip ids already used or removed', () => {
  assert.equal(nextStructureId([{ id: 'structure' }]), 'structure-2')
  assert.equal(nextStructureId([{ id: 'structure' }, { id: 'structure-2' }]), 'structure-3')
  assert.equal(
    nextStructureId([{ id: 'structure' }, { id: 'structure-2' }, { id: 'structure-3' }]),
    'structure-4',
  )
})
