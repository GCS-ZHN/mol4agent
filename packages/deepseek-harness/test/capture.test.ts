import assert from 'node:assert/strict'
import test from 'node:test'
import { CaptureHub, captureFileName } from '../src/host/capture.ts'

const session = 'session' as never
const ref = { attachmentId: 1 } as never

test('delivers a pending capture with its report', async () => {
  const hub = new CaptureHub()
  const pending = hub.wait(session, 'call', 1000, new AbortController().signal)
  assert.equal(hub.deliver(session, 'call', ref, { status: 'ready' }), true)
  assert.deepEqual(await pending, { ref, report: { status: 'ready' } })
  hub.dispose()
})

test('buffers a delivery that arrives before wait', async () => {
  const hub = new CaptureHub()
  assert.equal(hub.deliver(session, 'early', ref), true)
  assert.deepEqual(await hub.wait(session, 'early', 1000, new AbortController().signal), { ref, report: undefined })
  hub.dispose()
})

test('rejects duplicate, cancelled, timed-out, and disposed waits', async () => {
  const hub = new CaptureHub()
  const signal = new AbortController()
  const first = hub.wait(session, 'dupe', 1000, signal.signal)
  await assert.rejects(hub.wait(session, 'dupe', 1000, signal.signal), /already pending/)
  signal.abort()
  await assert.rejects(first, /cancelled/)

  await assert.rejects(hub.wait(session, 'timeout', 5, new AbortController().signal), /did not deliver/)

  const pending = hub.wait(session, 'dispose', 1000, new AbortController().signal)
  hub.dispose()
  await assert.rejects(pending, /unloading/)
  await assert.rejects(hub.wait(session, 'after', 5, new AbortController().signal), /unloading/)
})

test('dispose clears early deliveries', () => {
  const hub = new CaptureHub()
  hub.deliver(session, 'early', ref)
  hub.dispose()
  assert.equal(hub.deliver(session, 'early', ref), true)
  hub.dispose()
})

test('builds a Windows-safe capture file name from an attachment id', () => {
  const digest = '7dc1a1b2c3d4e5f6'
  const name = captureFileName(`sha256:${digest}`, 1794897007162)

  assert.equal(name, `mol4agent-1794897007162-${digest.slice(-12)}.png`)
  assert.match(name, /^mol4agent-\d+-[a-z0-9]+\.png$/u)
  // `:` would turn the file into an NTFS alternate data stream on Windows.
  for (const illegal of [':', '/', '\\', '?', '*', '"', '<', '>', '|']) {
    assert.equal(name.includes(illegal), false, illegal)
  }
  assert.ok(captureFileName(undefined, 42).endsWith('.png'))
})
