import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { test } from 'node:test'
import type { InspectResult } from '@gcszhn/mol4agent-core/protocol'
import { formatInspectResult } from '../src/format-inspect.ts'
import {
  decodeInspectPayload,
  decodeTmScorePayload,
  InspectHub,
  TmScoreHub,
} from '../src/inspect.ts'
import { encodeInspectAnswer, encodeTmScoreAnswer } from '../src/client/inspect.ts'
import { AlignHub, decodeAlignPayload } from '../src/align.ts'

const result: InspectResult = {
  target: 'chain A',
  detail: 'atoms',
  atoms: 2,
  residues: 1,
  chains: 1,
  models: 1,
  counts: [{ compId: 'ALA', kind: 'polymer', residues: 1, atoms: 2 }],
  residueRows: [{
    chain: 'A',
    seqId: 1,
    labelSeqId: 1,
    compId: 'ALA',
    kind: 'polymer',
    atoms: 2,
    x: 1,
    y: 2,
    z: 3,
    atomRows: [
      { name: 'N', element: 'N', x: 1, y: 2, z: 3, occupancy: 1, bFactor: 12.5 },
      { name: 'CA', element: 'C', x: 2, y: 3, z: 4, altId: 'A' },
    ],
  }],
  styles: [{
    component: 'Polymer',
    type: 'cartoon',
    color: 'chain-id',
    size: 'uniform',
    baseColor: '#1b9e77',
    visibleColor: '#22bb5b',
    overlays: [{ source: 'selection', color: '#33ff1a', strength: 0.3, label: 'selection' }],
  }],
  appearance: {
    baseColor: '#1b9e77',
    visibleColor: '#22bb5b',
    overlays: [{ source: 'selection', color: '#33ff1a', strength: 0.3, label: 'selection' }],
  },
  selection: {
    entries: 2,
    residues: 7,
    atoms: 60,
    groups: [{ residues: 5, atoms: 43 }, { residues: 2, atoms: 17 }],
  },
  truncated: false,
}

test('formats totals, appearance, selection groups, rows, atoms, and styles', () => {
  const text = formatInspectResult(result)
  assert.match(text, /<inspect target="chain A" detail="atoms">/)
  assert.match(text, /selection: 2 entries, 7 residues, 60 atoms \(entries: 5 residues\/43 atoms, 2 residues\/17 atoms\)/)
  assert.match(text, /- ALA \(polymer\): 1 residue, 2 atoms/)
  assert.match(text, /- A1 ALA \(polymer\): 2 atoms, center 1 2 3/)
  assert.match(text, /  - N N 1 2 3 b 12\.5/)
  assert.match(text, /  - CA C 2 3 4 alt A/)
  assert.match(text, /- Polymer: cartoon \/ chain-id \/ uniform base #1b9e77 -> visible #22bb5b/)
  assert.match(text, /appearance: base #1b9e77 -> visible #22bb5b/)
  assert.match(text, /- selection #33ff1a strength 0\.3 on selection/)
})

test('formatters keep a single selection group out of the header', () => {
  const text = formatInspectResult({
    ...result,
    selection: { entries: 1, residues: 5, atoms: 43, groups: [{ residues: 5, atoms: 43 }] },
  })
  assert.match(text, /selection: 1 entry, 5 residues, 43 atoms\n/)
  assert.doesNotMatch(text, /entries: 5 residues/)
})

test('decoders reject malformed payloads', () => {
  const good = gzipSync(Buffer.from(JSON.stringify({ ok: true, result }))).toString('base64')
  assert.deepEqual(decodeInspectPayload(good), { ok: true, result })
  assert.equal(decodeInspectPayload('not-base64'), undefined)

  const missingArrays = gzipSync(Buffer.from(JSON.stringify({ ok: true, result: { atoms: 1 } }))).toString('base64')
  assert.equal(decodeInspectPayload(missingArrays), undefined)

  assert.equal(decodeTmScorePayload('{"ok":true,"result":{"rmsd":1}}'), undefined)
  assert.deepEqual(
    decodeTmScorePayload(JSON.stringify({
      ok: true,
      result: {
        method: 'tm-align',
        reference: 'a',
        target: 'b',
        rmsd: 1,
        tmScoreA: 0.8,
        tmScoreB: 0.7,
        alignedLength: 10,
        referenceAtoms: 10,
        targetAtoms: 12,
      },
    })),
    {
      ok: true,
      result: {
        method: 'tm-align',
        reference: 'a',
        target: 'b',
        rmsd: 1,
        tmScoreA: 0.8,
        tmScoreB: 0.7,
        alignedLength: 10,
        referenceAtoms: 10,
        targetAtoms: 12,
      },
    },
  )
})

test('browser encoders round-trip through the server decoders', async () => {
  assert.deepEqual(
    decodeInspectPayload(await encodeInspectAnswer({ ok: true, result })),
    { ok: true, result },
  )
  const score = {
    method: 'tm-align' as const,
    reference: 'a',
    target: 'b',
    rmsd: 1,
    tmScoreA: 0.8,
    tmScoreB: 0.7,
    alignedLength: 10,
    referenceAtoms: 10,
    targetAtoms: 12,
  }
  assert.deepEqual(
    decodeTmScorePayload(encodeTmScoreAnswer({ ok: true, result: score })),
    { ok: true, result: score },
  )
})

test('query hubs scope claims to a scene and resolve the waiting call', async () => {
  const hub = new InspectHub()
  const pending = hub.enqueue('scene-a', { detail: 'summary' })
  assert.equal(hub.hasPending('scene-b'), false)
  assert.equal(hub.claim('scene-b'), null)
  assert.equal(hub.claim('scene-a')?.queryId, pending.queryId)
  const waiting = hub.wait(pending.queryId, 1_000, new AbortController().signal)
  assert.equal(hub.deliver(pending.queryId, { ok: true, result }), true)
  assert.deepEqual(await waiting, { ok: true, result })
  assert.equal(hub.deliver(pending.queryId, { ok: true, result }), false)

  const scores = new TmScoreHub()
  const scoreQuery = scores.enqueue('scene-a', {
    reference: { kind: 'chain', chain: 'A' },
    target: { kind: 'chain', chain: 'B' },
  })
  scores.claim('scene-a')
  const scoreWaiting = scores.wait(scoreQuery.queryId, 1_000, new AbortController().signal)
  assert.equal(scores.fail(scoreQuery.queryId, 'no trace atoms'), true)
  assert.deepEqual(await scoreWaiting, { ok: false, message: 'no trace atoms' })
})

test('alignment hub matches scene command indexes and decodes metrics', async () => {
  const hub = new AlignHub()
  const waiting = hub.wait('scene-a', 3, 1_000, new AbortController().signal)
  const answer = {
    ok: true as const,
    result: {
      method: 'tm-align' as const,
      reference: 'a',
      target: 'b',
      rmsd: 1.2,
      alignedLength: 100,
      tmScoreA: 0.9,
      tmScoreB: 0.8,
    },
  }
  assert.equal(hub.has('scene-a', 2), false)
  assert.equal(hub.deliver('scene-a', 2, answer), false)
  assert.equal(hub.deliver('scene-a', 3, answer), true)
  assert.deepEqual(await waiting, answer)

  assert.deepEqual(decodeAlignPayload(JSON.stringify(answer)), answer)
  assert.equal(decodeAlignPayload('{"ok":true,"result":{"rmsd":1}}'), undefined)
})
