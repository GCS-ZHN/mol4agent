import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import test from 'node:test'
import type { InspectResult } from '@gcszhn/mol4agent-core/protocol'
import { formatInspectResult } from '../src/host/format-inspect.ts'
import { InspectHub } from '../src/host/inspect.ts'
import { MAX_INSPECT_PAYLOAD_BYTES, decodeInspectPayload } from '../src/host/inspect-payload.ts'
import { molProjectionDefinition } from '../src/host/projection.ts'
import { canonicalTabPath } from '../src/tab-path.ts'

const session = 'session' as never

function encode(value: unknown): string {
  return gzipSync(Buffer.from(JSON.stringify(value), 'utf8')).toString('base64')
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
    { component: 'Structure', type: 'cartoon', color: 'chain-id', size: 'physical', colorValue: '#00ff00' },
    { component: 'mol4agent selection', type: 'ball-and-stick', color: 'uniform', size: 'physical', hidden: true },
  ],
  selection: { entries: 1, atoms: 2, residues: 1 },
  truncated: false,
}

test('inspect hub resolves a waiting tool call with a result', async () => {
  const hub = new InspectHub()
  const pending = hub.wait(session, 'call', 1000, new AbortController().signal)
  assert.equal(hub.deliver(session, 'call', { ok: true, result }), true)
  assert.deepEqual(await pending, { ok: true, result })
  hub.dispose()
})

test('inspect hub resolves a viewer failure instead of timing out', async () => {
  const hub = new InspectHub()
  const pending = hub.wait(session, 'call', 1000, new AbortController().signal)
  hub.deliver(session, 'call', { ok: false, message: 'no structure is loaded' })
  assert.deepEqual(await pending, { ok: false, message: 'no structure is loaded' })
  hub.dispose()
})

test('inspect hub reports its own timeout wording', async () => {
  const hub = new InspectHub()
  await assert.rejects(
    hub.wait(session, 'slow', 5, new AbortController().signal),
    /did not answer the query/,
  )
  hub.dispose()
})

test('decodes a gzip payload back into a result', () => {
  assert.deepEqual(decodeInspectPayload(encode({ ok: true, result })), { ok: true, result })
  assert.deepEqual(decodeInspectPayload(encode({ ok: false, message: 'no structure is loaded' })), {
    ok: false,
    message: 'no structure is loaded',
  })
})

test('rejects unusable inspect payloads without throwing', () => {
  assert.equal(decodeInspectPayload('not-base64-at-all'), undefined)
  assert.equal(decodeInspectPayload(Buffer.from('plain text').toString('base64')), undefined)
  assert.deepEqual(decodeInspectPayload(encode({ ok: false })), {
    ok: false,
    message: 'the viewer could not answer the query',
  }, 'a failure without a message still resolves the tool call')
  assert.equal(decodeInspectPayload(encode({ ok: true })), undefined, 'missing result')
  assert.equal(decodeInspectPayload(encode([1, 2, 3])), undefined)
})

test('caps the decompressed payload', () => {
  const big = 'x'.repeat(MAX_INSPECT_PAYLOAD_BYTES + 1024)
  assert.equal(decodeInspectPayload(encode({ ok: false, message: big })), undefined)
})

test('formats counts, styles, and live selections', () => {
  const text = formatInspectResult(result)
  assert.match(text, /<inspect target="whole structure" detail="summary">/u)
  assert.match(text, /atoms: 5, residues: 4, chains: 1, models: 1/u)
  assert.match(text, /selection: 1 entry, 1 residues, 2 atoms/u)
  assert.match(text, /counts:/u)
  assert.match(text, /- HOH \(water\): 2 residues, 2 atoms/u)
  assert.match(text, /- CYS \(polymer\): 1 residue, 1 atom/u)
  assert.match(text, /- Structure: cartoon \/ chain-id #00ff00 \/ physical/u)
  assert.match(text, /- mol4agent selection: ball-and-stick \/ uniform \/ physical \(hidden\)/u, 'a hidden representation is flagged')
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

test('inspect queries are keyed by tab and cleared on tool result', () => {
  const definition = molProjectionDefinition()
  type State = ReturnType<typeof definition['init']>
  // A real absolute cwd on the running platform: `/tmp` on POSIX, `C:\tmp` on
  // Windows. The projection must key `inspecting` by the canonical spelling.
  const CWD = resolve('/tmp')
  const init = (): State => definition.init({ cwd: CWD } as never)
  const key = (name: string): string => canonicalTabPath(resolve(CWD, name))
  const call = (name: string, args: Record<string, unknown>, callId: string) =>
    ({ type: 'tool/call', data: { name, callId, arguments: JSON.stringify(args) } }) as never
  const settled = (callId: string) =>
    ({ type: 'tool/result', data: { message: { toolCallId: callId } } }) as never

  let state = init()
  state = definition.apply(state, call('mol_open', { path: 'a.pdb' }, 'a'))
  state = definition.apply(state, call('mol_open', { path: 'b.pdb' }, 'b'))
  state = definition.apply(state, call('mol_inspect', { tab: key('a.pdb'), detail: 'residues', limit: 10 }, 'ask'))

  assert.equal(state.inspecting.ask?.path, key('a.pdb'))
  assert.equal(state.inspecting.ask?.detail, 'residues')
  assert.equal(state.inspecting.ask?.limit, 10)

  state = definition.apply(state, settled('ask'))
  assert.equal(state.inspecting.ask, undefined)
})

test('inspect accepts live selection targets and rejects unknown ones', () => {
  const definition = molProjectionDefinition()
  type State = ReturnType<typeof definition['init']>
  const CWD = resolve('/tmp')
  const init = (): State => definition.init({ cwd: CWD } as never)
  const call = (name: string, args: Record<string, unknown>, callId: string) =>
    ({ type: 'tool/call', data: { name, callId, arguments: JSON.stringify(args) } }) as never

  let state = init()
  state = definition.apply(state, call('mol_open', { path: 'a.pdb' }, 'a'))
  state = definition.apply(state, call('mol_inspect', {
    target: { kind: 'selection' },
    detail: 'residues',
  }, 'sel'))
  assert.deepEqual(state.inspecting.sel?.target, { kind: 'selection' })
  assert.equal(state.inspecting.sel?.detail, 'residues')
  assert.equal(state.inspecting.sel?.limit, undefined)

  const before = state
  state = definition.apply(state, call('mol_inspect', { target: { kind: 'bogus' } }, 'bad'))
  assert.equal(state, before, 'an unusable target leaves the projection untouched')
})
