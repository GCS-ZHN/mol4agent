import assert from 'node:assert/strict'
import { test } from 'node:test'
import { captureDecision, mergeScenes, missingPaths, oldestEvictions, routeSceneEvent, selectScene } from '../src/gui/routing.ts'

const SCENES = [
  { path: '/a.pdb', sceneId: 'scene-a', label: 'a.pdb' },
  { path: '/b.pdb', sceneId: 'scene-b', label: 'b.pdb' },
]

test('mergeScenes indexes by path', () => {
  assert.deepEqual(Object.keys(mergeScenes(SCENES)), ['/a.pdb', '/b.pdb'])
  assert.equal(mergeScenes(SCENES)['/b.pdb']?.sceneId, 'scene-b')
})

test('selectScene never falls back across sessions', () => {
  const bySession = { A: mergeScenes(SCENES), B: {} }
  assert.equal(selectScene(bySession, 'A', '/a.pdb')?.sceneId, 'scene-a')
  assert.equal(selectScene(bySession, 'B', '/a.pdb'), undefined)
  assert.equal(selectScene(bySession, 'A', '/missing.pdb'), undefined)
})

test('a scene event for the routed session refreshes it', () => {
  assert.deepEqual(routeSceneEvent('A', { sessionID: 'A' }), { action: 'refresh', sessionID: 'A' })
  assert.deepEqual(routeSceneEvent('A', { sessionID: 'A', open: true, path: '/a.pdb' }), {
    action: 'refresh',
    sessionID: 'A',
    path: '/a.pdb',
  })
})

test('an open event for another session is queued', () => {
  assert.deepEqual(routeSceneEvent('B', { sessionID: 'A', open: true, path: '/a.pdb' }), {
    action: 'queue',
    sessionID: 'A',
    path: '/a.pdb',
  })
})

test('a non-open event for another session is ignored', () => {
  assert.deepEqual(routeSceneEvent('B', { sessionID: 'A' }), { action: 'ignore' })
})

test('a missing sessionID means the routed session', () => {
  assert.deepEqual(routeSceneEvent('A', {}), { action: 'refresh', sessionID: 'A' })
})

test('capture delivery never crosses sessions', () => {
  assert.equal(captureDecision('A', 'B', true), 'leave-pending')
  assert.equal(captureDecision('A', 'B', false), 'leave-pending')
})

test('capture fails only when the routed session has no viewer', () => {
  assert.equal(captureDecision('A', 'A', false), 'fail')
  assert.equal(captureDecision('A', 'A', true), 'deliver')
})

test('stored tabs are only marked missing after the scene list loads', () => {
  assert.deepEqual(missingPaths(['/a.pdb', '/gone.pdb'], ['/a.pdb'], false), [])
  assert.deepEqual(missingPaths(['/a.pdb', '/gone.pdb'], ['/a.pdb'], true), ['/gone.pdb'])
  assert.deepEqual(missingPaths([], [], true), [])
})

test('LRU evictions skip the active slot', () => {
  assert.deepEqual(oldestEvictions(['a', 'b', 'c'], 'c', 3), [])
  assert.deepEqual(oldestEvictions(['a', 'b', 'c', 'd'], 'd', 3), ['a'])
  assert.deepEqual(oldestEvictions(['a', 'b', 'c', 'd', 'e'], 'e', 3), ['a', 'b'])
  assert.deepEqual(oldestEvictions(['a', 'b', 'c'], 'a', 2), ['b'])
})
