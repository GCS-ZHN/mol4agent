import assert from 'node:assert/strict'
import test from 'node:test'
import { AlignHub, type AlignDelivery } from '../src/host/align.ts'

const delivery: AlignDelivery = {
  ok: true,
  result: {
    method: 'tm-align',
    reference: 'structure',
    target: 'target',
    rmsd: 1.25,
    alignedLength: 110,
    tmScoreA: 0.98,
    tmScoreB: 0.97,
    sequenceIdentity: 0.85,
  },
}

test('align hub resolves a waiter with metrics', async () => {
  const hub = new AlignHub()
  const pending = hub.wait('session' as never, 'call', 1000, new AbortController().signal)
  assert.equal(hub.deliver('session' as never, 'call', delivery), true)
  assert.deepEqual(await pending, delivery)
  hub.dispose()
})

test('align hub keeps early deliveries for the same call', async () => {
  const hub = new AlignHub()
  assert.equal(hub.deliver('session' as never, 'call', delivery), true)
  assert.deepEqual(await hub.wait('session' as never, 'call', 1000, new AbortController().signal), delivery)
  hub.dispose()
})

test('align hub times out without a delivery', async () => {
  const hub = new AlignHub()
  await assert.rejects(
    hub.wait('session' as never, 'call', 20, new AbortController().signal),
    /did not report alignment metrics/u,
  )
  hub.dispose()
})

test('align hub rejects pending waiters on dispose', async () => {
  const hub = new AlignHub()
  const pending = hub.wait('session' as never, 'call', 1000, new AbortController().signal)
  hub.dispose()
  await assert.rejects(pending, /unloading/u)
})
