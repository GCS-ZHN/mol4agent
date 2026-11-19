import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { InspectResult } from '@gcszhn/mol4agent-core/protocol'
import { formatInspectResult } from '../src/format-inspect.ts'
import { InspectHub, TmScoreHub, inspectAnswerOf, tmScoreAnswerOf } from '../src/inspect.ts'
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

const result: InspectResult = {
  target: 'whole structure',
  detail: 'summary',
  atoms: 5,
  residues: 4,
  chains: 1,
  models: 1,
  counts: [
    { compId: 'HOH', kind: 'water', residues: 2, atoms: 2 },
    { compId: 'CYS', kind: 'polymer', residues: 1, atoms: 1 },
  ],
  styles: [
    {
      component: 'Structure',
      type: 'cartoon',
      color: 'chain-id',
      size: 'physical',
      baseColor: '#1b9e77',
      visibleColor: '#22bb5b',
      overlays: [{ source: 'selection', color: '#33ff1a', strength: 0.3 }],
    },
    { component: 'mol4agent selection', type: 'ball-and-stick', color: 'uniform', size: 'physical', hidden: true },
  ],
  appearance: {
    baseColor: '#1b9e77',
    visibleColor: '#22bb5b',
    overlays: [{ source: 'selection', color: '#33ff1a', strength: 0.3 }],
  },
  selection: { entries: 1, atoms: 2, residues: 1, groups: [{ residues: 1, atoms: 2 }] },
  truncated: false,
}

function enqueue(hub: InspectHub, sessionID = 'session', request = {}) {
  return hub.enqueue({ sessionID, scene: SCENE, request })
}

test('inspect hub resolves a waiting tool call with a result', async () => {
  const hub = new InspectHub()
  const pending = enqueue(hub)
  const wait = hub.wait(pending.queryId, 1000, new AbortController().signal)
  assert.equal(hub.deliver(pending.queryId, { ok: true, result }), true)
  assert.deepEqual(await wait, { ok: true, result })
})

test('inspect hub resolves a viewer failure instead of timing out', async () => {
  const hub = new InspectHub()
  const pending = enqueue(hub)
  const wait = hub.wait(pending.queryId, 1000, new AbortController().signal)
  assert.equal(hub.fail(pending.queryId, 'no structure is loaded'), true)
  assert.deepEqual(await wait, { ok: false, message: 'no structure is loaded' })
})

test('inspect hub keeps a delivery that beats the wait briefly', async () => {
  const hub = new InspectHub()
  const pending = enqueue(hub)
  assert.equal(hub.deliver(pending.queryId, { ok: true, result }), true)
  assert.deepEqual(await hub.wait(pending.queryId, 1000, new AbortController().signal), { ok: true, result })
  // The waiter consumed the answer and the queue entry.
  assert.equal(hub.pendingForSession('session').length, 0)
  assert.equal(hub.deliver(pending.queryId, { ok: true, result }), false)
})

test('inspect hub ignores deliveries for unknown queries', () => {
  const hub = new InspectHub()
  assert.equal(hub.deliver('missing', { ok: true, result }), false)
  assert.equal(hub.fail('missing', 'boom'), false)
})

test('inspect hub filters pending queries by session', () => {
  const hub = new InspectHub()
  enqueue(hub, 'A')
  enqueue(hub, 'B')
  assert.equal(hub.pendingForSession('A').length, 1)
  assert.equal(hub.pendingForSession('C').length, 0)
})

test('abort rejects and removes a pending inspection', async () => {
  const hub = new InspectHub()
  const pending = enqueue(hub)
  const controller = new AbortController()
  const wait = hub.wait(pending.queryId, 5000, controller.signal)
  controller.abort()
  await assert.rejects(wait, /viewer query was cancelled/u)
  assert.equal(hub.pendingForSession('session').length, 0)
})

test('wait times out and removes the pending inspection', async () => {
  const hub = new InspectHub()
  const pending = enqueue(hub)
  await assert.rejects(
    hub.wait(pending.queryId, 10, new AbortController().signal),
    /did not answer the query in time/u,
  )
  assert.equal(hub.pendingForSession('session').length, 0)
})

test('delivered answers are validated at the RPC boundary', () => {
  assert.deepEqual(inspectAnswerOf({ ok: true, result }), { ok: true, result })
  assert.deepEqual(inspectAnswerOf({ ok: false, message: 'no structure is loaded' }), {
    ok: false,
    message: 'no structure is loaded',
  })
  assert.deepEqual(inspectAnswerOf({ ok: false }), {
    ok: false,
    message: 'the viewer could not answer the query',
  }, 'a failure without a message still resolves the tool call')
  assert.equal(inspectAnswerOf(null), undefined)
  assert.equal(inspectAnswerOf('nope'), undefined)
  assert.equal(inspectAnswerOf({ ok: true }), undefined, 'missing result')
  assert.equal(inspectAnswerOf({ ok: true, result: { ...result, styles: undefined } }), undefined, 'missing arrays')
  assert.equal(inspectAnswerOf({ ok: true, result: { ...result, counts: null } }), undefined)
  assert.equal(inspectAnswerOf({ ok: true, result: { ...result, target: 42 } }), undefined)
})

test('formats counts, styles, and live selections', () => {
  const text = formatInspectResult(result)
  assert.match(text, /<inspect target="whole structure" detail="summary">/u)
  assert.match(text, /atoms: 5, residues: 4, chains: 1, models: 1/u)
  assert.match(text, /selection: 1 entry, 1 residue, 2 atoms/u)
  assert.match(text, /counts:/u)
  assert.match(text, /- HOH \(water\): 2 residues, 2 atoms/u)
  assert.match(text, /- CYS \(polymer\): 1 residue, 1 atom/u)
  assert.match(text, /- Structure: cartoon \/ chain-id \/ physical base #1b9e77 -> visible #22bb5b/u)
  assert.match(text, /- mol4agent selection: ball-and-stick \/ uniform \/ physical \(hidden\)/u)
  assert.match(text, /appearance: base #1b9e77 -> visible #22bb5b/u)
  assert.match(text, /- selection #33ff1a strength 0\.3/u)
  assert.match(text, /<\/inspect>/u)
})

test('formats residue and atom rows with coordinates and truncation', () => {
  const detailed: InspectResult = {
    ...result,
    target: 'residue E355',
    detail: 'atoms',
    counts: [{ compId: 'ATP', kind: 'ligand', residues: 1, atoms: 2 }],
    selection: undefined,
    styles: [],
    truncated: true,
    residueRows: [
      {
        chain: 'E',
        seqId: 355,
        labelSeqId: 355,
        compId: 'ATP',
        kind: 'ligand',
        atoms: 2,
        x: 16.223,
        y: 8.151,
        z: -1.015,
        atomRows: [
          { name: 'PG', element: 'P', x: 16.223, y: 8.151, z: -1.015, occupancy: 1, bFactor: 18.11 },
          { name: 'O1G', element: 'O', x: 17.55, y: 8.536, z: -0.515, occupancy: 0.5, altId: 'A' },
        ],
      },
    ],
  }
  const text = formatInspectResult(detailed)
  assert.match(text, /- E355 ATP \(ligand\): 2 atoms, center 16\.223 8\.151 -1\.015/u)
  // Occupancy 1 is the default and stays implicit; partial occupancy is shown.
  assert.match(text, /  - PG P 16\.223 8\.151 -1\.015 b 18\.11/u)
  assert.match(text, /  - O1G O 17\.55 8\.536 -0\.515 occ 0\.5 alt A/u)
  assert.match(text, /rows are truncated/u)
})

test('formats an empty match explicitly', () => {
  const empty: InspectResult = {
    ...result,
    detail: 'residues',
    counts: [],
    styles: [],
    selection: undefined,
    atoms: 0,
    residues: 0,
    residueRows: [],
  }
  assert.match(formatInspectResult(empty), /no residues matched this target/u)
})


test('TM-score hub resolves answers and validates payloads', async () => {
  const hub = new TmScoreHub()
  const pending = hub.enqueue({ sessionID: 'session', scene: SCENE, request: { reference: { kind: 'protein' }, target: { kind: 'protein' } } })
  const wait = hub.wait(pending.queryId, 1000, new AbortController().signal)
  const answer = {
    ok: true as const,
    result: {
      method: 'tm-align' as const,
      reference: 'protein',
      target: 'protein',
      rmsd: 1.25,
      tmScoreA: 0.91,
      tmScoreB: 0.88,
      alignedLength: 120,
      referenceAtoms: 130,
      targetAtoms: 128,
    },
  }
  assert.deepEqual(tmScoreAnswerOf(answer), answer)
  assert.equal(hub.deliver(pending.queryId, answer), true)
  assert.deepEqual(await wait, answer)
  assert.equal(tmScoreAnswerOf({ ok: true, result: { ...answer.result, tmScoreA: 'high' } }), undefined)
  assert.deepEqual(tmScoreAnswerOf({ ok: false }), {
    ok: false,
    message: 'the viewer could not compute a TM-score',
  })
})
