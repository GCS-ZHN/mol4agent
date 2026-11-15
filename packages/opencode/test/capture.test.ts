import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CaptureHub } from '../src/capture.ts'
import type { SceneSnapshot } from '../src/scene.ts'

const SCENE: SceneSnapshot = {
  sceneId: 'scene-1',
  path: '/a.pdb',
  label: 'a.pdb',
  format: 'pdb',
  binary: false,
  revision: 1,
  commands: [],
}

test('deliver resolves a waiting capture', async () => {
  const hub = new CaptureHub()
  const pending = hub.enqueue({ sessionID: 'ses', scene: SCENE, width: 10, height: 10, transparent: false, saveDir: '/tmp' })
  const wait = hub.wait(pending.captureId, 5000, new AbortController().signal)
  assert.equal(hub.deliver(pending.captureId, { png: new Uint8Array([1, 2, 3]), width: 10, height: 10, path: '/tmp/x.png' }), true)
  const delivery = await wait
  assert.equal(delivery.path, '/tmp/x.png')
})

test('pendingForSession filters by session', () => {
  const hub = new CaptureHub()
  hub.enqueue({ sessionID: 'A', scene: SCENE, width: 10, height: 10, transparent: false, saveDir: '/tmp' })
  hub.enqueue({ sessionID: 'B', scene: SCENE, width: 10, height: 10, transparent: false, saveDir: '/tmp' })
  assert.equal(hub.pendingForSession('A').length, 1)
  assert.equal(hub.pendingForSession('C').length, 0)
})

test('abort rejects and removes the pending capture', async () => {
  const hub = new CaptureHub()
  const pending = hub.enqueue({ sessionID: 'A', scene: SCENE, width: 10, height: 10, transparent: false, saveDir: '/tmp' })
  const controller = new AbortController()
  const wait = hub.wait(pending.captureId, 5000, controller.signal)
  controller.abort()
  await assert.rejects(wait)
  assert.equal(hub.saveDirOf(pending.captureId), undefined)
})

test('fail rejects a waiting capture', async () => {
  const hub = new CaptureHub()
  const pending = hub.enqueue({ sessionID: 'A', scene: SCENE, width: 10, height: 10, transparent: false, saveDir: '/tmp' })
  const wait = hub.wait(pending.captureId, 5000, new AbortController().signal)
  assert.equal(hub.fail(pending.captureId, 'boom'), true)
  await assert.rejects(wait, /boom/u)
})

test('wait times out and removes the pending capture', async () => {
  const hub = new CaptureHub()
  const pending = hub.enqueue({ sessionID: 'A', scene: SCENE, width: 10, height: 10, transparent: false, saveDir: '/tmp' })
  await assert.rejects(
    hub.wait(pending.captureId, 10, new AbortController().signal),
    /did not deliver a screenshot in time/u,
  )
  assert.equal(hub.saveDirOf(pending.captureId), undefined)
})
