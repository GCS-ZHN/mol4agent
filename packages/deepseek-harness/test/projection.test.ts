import assert from 'node:assert/strict'
import test from 'node:test'
import { molProjectionDefinition } from '../src/host/projection.ts'

type State = ReturnType<ReturnType<typeof molProjectionDefinition>['init']>

const definition = molProjectionDefinition()
const init = (): State => definition.init({ cwd: '/tmp' } as never)

test('is versioned for the per-tab schema', () => {
  assert.equal(definition.stateVersion, 2)
})

function call(name: string, args: Record<string, unknown>, callId: string) {
  return { type: 'tool/call', data: { name, callId, arguments: JSON.stringify(args) } } as never
}

function result(callId: string) {
  return { type: 'tool/result', data: { message: { toolCallId: callId } } } as never
}

test('keeps independent scenes and commands per tab', () => {
  let state = init()
  state = definition.apply(state, call('mol_open', { path: 'a.pdb' }, 'a'))
  state = definition.apply(state, call('mol_open', { path: 'b.pdb' }, 'b'))

  assert.deepEqual(Object.keys(state.tabs), ['/tmp/a.pdb', '/tmp/b.pdb'])
  assert.equal(state.active, '/tmp/b.pdb')
  assert.equal(state.tabs['/tmp/a.pdb']?.commands.length, 1)

  state = definition.apply(state, call('mol_style', {
    tab: '/tmp/a.pdb',
    color: 'uniform',
    colorParams: { value: 0xff0000 },
  }, 'style-a'))
  assert.equal(state.tabs['/tmp/a.pdb']?.commands.length, 2)
  assert.equal(state.tabs['/tmp/b.pdb']?.commands.length, 1)

  state = definition.apply(state, call('mol_measure', {
    tab: '/tmp/a.pdb',
    kind: 'distance',
    targets: [
      { kind: 'residue', chain: 'A', index: 33 },
      { kind: 'residue', chain: 'B', index: 73 },
    ],
  }, 'measure-a'))
  assert.equal(state.tabs['/tmp/a.pdb']?.commands.length, 3)
  assert.equal(state.tabs['/tmp/b.pdb']?.commands.length, 1)
})

test('capture targets the requested tab and clears on result', () => {
  let state = init()
  state = definition.apply(state, call('mol_open', { path: 'a.pdb' }, 'a'))
  state = definition.apply(state, call('mol_open', { path: 'b.pdb' }, 'b'))
  state = definition.apply(state, call('mol_capture', { tab: '/tmp/a.pdb', width: 640 }, 'shot'))

  assert.equal(state.pending.shot?.path, '/tmp/a.pdb')
  assert.equal(state.pending.shot?.width, 640)

  state = definition.apply(state, result('shot'))
  assert.equal(state.pending.shot, undefined)
})

test('invalid tab/select and wrong measurement counts do not mutate a scene', () => {
  let state = init()
  const empty = state
  assert.equal(definition.apply(empty, call('mol_capture', {}, 'no-scene')), empty)
  assert.equal(definition.apply(empty, call('mol_open', { path: 'x.txt' }, 'bad-format')), empty)

  state = definition.apply(state, call('mol_open', { path: 'a.pdb' }, 'a'))
  const before = state
  state = definition.apply(state, call('mol_style', { tab: '/tmp/missing.pdb' }, 'missing'))
  assert.equal(state, before)

  state = definition.apply(state, call('mol_open', { path: 'bad.pdb', select: { kind: 'bogus' } }, 'bad'))
  assert.equal(state, before)

  state = definition.apply(state, call('mol_measure', {
    tab: '/tmp/a.pdb',
    kind: 'angle',
    targets: [{ kind: 'residue', chain: 'A', index: 1 }, { kind: 'residue', chain: 'A', index: 2 }],
  }, 'angle'))
  assert.equal(state.tabs['/tmp/a.pdb']?.commands.length, 1)

  state = definition.apply(state, call('mol_measure', {
    tab: '/tmp/a.pdb',
    kind: 'distance',
    targets: [{ kind: 'ligand' }, { kind: 'protein' }],
  }, 'semantic'))
  assert.equal(state.tabs['/tmp/a.pdb']?.commands.length, 1)

  assert.equal(definition.apply(state, result('unrelated')), state)
})

test('defaults to the active tab and reopens the same path in place', () => {
  let state = init()
  state = definition.apply(state, call('mol_open', { path: 'a.pdb' }, 'a1'))
  state = definition.apply(state, call('mol_open', { path: 'b.pdb' }, 'b1'))

  state = definition.apply(state, call('mol_style', { color: 'uniform', colorParams: { value: 0xff0000 } }, 'style-active'))
  assert.equal(state.tabs['/tmp/a.pdb']?.commands.length, 1)
  assert.equal(state.tabs['/tmp/b.pdb']?.commands.length, 2)

  state = definition.apply(state, call('mol_open', { path: 'a.pdb' }, 'a2'))
  assert.equal(Object.keys(state.tabs).length, 2)
  assert.equal(state.tabs['/tmp/a.pdb']?.sceneKey, '/tmp/a.pdb#a2')
  assert.equal(state.tabs['/tmp/a.pdb']?.commands.length, 1)
  assert.equal(state.active, '/tmp/a.pdb')
})
