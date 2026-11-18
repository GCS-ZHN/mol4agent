import assert from 'node:assert/strict'
import test from 'node:test'
import { TmScoreHub } from '../src/host/tm-score.ts'

const answer = {
  ok: true as const,
  result: {
    method: 'tm-align' as const,
    reference: 'chain B',
    target: 'chain A',
    rmsd: 1,
    tmScoreA: 0.88,
    tmScoreB: 0.95,
    alignedLength: 115,
    referenceAtoms: 125,
    targetAtoms: 115,
  },
}

test('TM-score hub resolves a waiter', async () => {
  const hub = new TmScoreHub()
  const pending = hub.wait('session' as never, 'call', 1000, new AbortController().signal)
  assert.equal(hub.deliver('session' as never, 'call', answer), true)
  assert.deepEqual(await pending, answer)
  hub.dispose()
})

test('TM-score hub times out without an answer', async () => {
  const hub = new TmScoreHub()
  await assert.rejects(
    hub.wait('session' as never, 'call', 20, new AbortController().signal),
    /did not report TM-score metrics/u,
  )
  hub.dispose()
})
