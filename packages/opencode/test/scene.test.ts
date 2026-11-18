import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SceneStore, activeStructures, nextStructureId } from '../src/scene.ts'

const PDB = new TextEncoder().encode(
  'ATOM      1  N   ALA A   1      0.000   0.000   0.000  1.00  0.00           N\nEND\n',
)

function open(store: SceneStore, sessionID: string, path: string, commands: Parameters<SceneStore['open']>[1]['commands'] = []) {
  return store.open(sessionID, { path, label: path, format: 'pdb', bytes: PDB, commands })
}

test('open, active, list', () => {
  const store = new SceneStore()
  const a = open(store, 'ses', '/a.pdb')
  assert.equal(a.revision, 1)
  assert.equal(store.list('ses').active, '/a.pdb')
  assert.equal(store.list('ses').scenes.length, 1)
  open(store, 'ses', '/b.pdb')
  assert.equal(store.list('ses').active, '/b.pdb')
  assert.equal(store.list('ses').scenes.length, 2)
})

test('per-session isolation', () => {
  const store = new SceneStore()
  open(store, 'A', '/a.pdb')
  assert.equal(store.list('B').scenes.length, 0)
  assert.equal(store.snapshot('B', null), null)
  assert.equal(store.active('B'), null)
})

test('push increments revision and appends commands', () => {
  const store = new SceneStore()
  open(store, 'ses', '/a.pdb')
  store.push('ses', null, { op: 'focus' })
  const snap = store.snapshot('ses', null)
  assert.equal(snap?.revision, 2)
  assert.equal(snap?.commands.length, 1)
})

test('push targets a specific tab', () => {
  const store = new SceneStore()
  open(store, 'ses', '/a.pdb')
  const b = open(store, 'ses', '/b.pdb')
  store.push('ses', '/a.pdb', { op: 'focus' })
  assert.equal(store.snapshot('ses', '/a.pdb')?.commands.length, 1)
  assert.equal(store.snapshot('ses', b.path)?.commands.length, 0)
})

test('fetch returns base64 bytes', () => {
  const store = new SceneStore()
  const a = open(store, 'ses', '/a.pdb')
  const fetched = store.fetch(a.sceneId)
  assert.equal(fetched?.format, 'pdb')
  assert.ok((fetched?.data.length ?? 0) > 0)
})

test('reopening a path invalidates the old scene id', () => {
  const store = new SceneStore()
  const a = open(store, 'ses', '/a.pdb')
  open(store, 'ses', '/a.pdb', [{ op: 'focus' }])
  assert.equal(store.recordBySceneId(a.sceneId), undefined)
  assert.equal(store.list('ses').scenes.length, 1)
})

test('evicts oldest non-active tab above the cap', () => {
  const store = new SceneStore()
  for (let index = 0; index < 20; index += 1) open(store, 'ses', `/s${index}.pdb`)
  assert.ok(store.list('ses').scenes.length <= 12)
  assert.equal(store.list('ses').active, '/s19.pdb')
})

test('fetch is scoped to the owning session', () => {
  const store = new SceneStore()
  const a = open(store, 'A', '/a.pdb')
  assert.ok(store.fetch(a.sceneId, 'A') !== undefined)
  assert.equal(store.fetch(a.sceneId, 'B'), undefined)
  // Without a session argument the lookup stays session-agnostic.
  assert.ok(store.fetch(a.sceneId) !== undefined)
})

test('fetch returns undefined for an evicted scene', () => {
  const store = new SceneStore()
  const first = open(store, 'ses', '/s0.pdb')
  for (let index = 1; index < 20; index += 1) open(store, 'ses', `/s${index}.pdb`)
  assert.equal(store.fetch(first.sceneId), undefined)
})

test('adds structures without replacing the primary scene', () => {
  const store = new SceneStore()
  const a = open(store, 'ses', '/a.pdb')
  assert.deepEqual(a.structures.map(structure => structure.id), ['structure'])
  const next = store.addStructure('ses', null, {
    id: 'second',
    path: '/b.pdb',
    label: 'b.pdb',
    format: 'pdb',
    bytes: PDB,
  })
  assert.equal(next?.revision, a.revision + 1)
  assert.deepEqual(next?.structures.map(structure => structure.id), ['structure', 'second'])
  const fetched = store.fetchStructure(a.sceneId, 'second')
  assert.equal(fetched?.structureId, 'second')
  assert.equal(fetched?.label, 'b.pdb')
})

test('rejects a duplicate structure id', () => {
  const store = new SceneStore()
  const a = open(store, 'ses', '/a.pdb')
  assert.throws(
    () => store.addStructure('ses', null, {
      id: 'structure',
      path: '/b.pdb',
      label: 'b.pdb',
      format: 'pdb',
      bytes: PDB,
    }),
    /already used/u,
  )
  assert.ok(store.fetchStructure(a.sceneId, 'structure') !== undefined)
})

test('remove commands retire structures from the active list', () => {
  const store = new SceneStore()
  const a = open(store, 'ses', '/a.pdb')
  store.addStructure('ses', null, {
    id: 'second',
    path: '/b.pdb',
    label: 'b.pdb',
    format: 'pdb',
    bytes: PDB,
  })
  store.push('ses', null, { op: 'remove-structure', structureId: 'second' })
  const snapshot = store.snapshot('ses', null)
  assert.ok(snapshot !== null)
  assert.deepEqual(activeStructures(snapshot).map(structure => structure.id), ['structure'])
  // The removed structure is still fetchable so a fresh viewer can replay the command.
  assert.ok(store.fetchStructure(a.sceneId, 'second') !== undefined)
})

test('nextStructureId skips every id already used', () => {
  assert.equal(nextStructureId([]), 'structure-2')
  assert.equal(nextStructureId([{ id: 'structure' }, { id: 'structure-2' }]), 'structure-3')
})
