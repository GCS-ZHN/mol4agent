import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SceneStore } from '../src/scene.ts'

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
