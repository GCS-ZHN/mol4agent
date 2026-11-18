import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { molProjectionDefinition } from '../src/host/projection.ts'
import { canonicalTabPath } from '../src/tab-path.ts'

type State = ReturnType<ReturnType<typeof molProjectionDefinition>['init']>

const definition = molProjectionDefinition()
// A real absolute cwd on the running platform: `/tmp` on POSIX, `C:\tmp` on
// Windows. The projection must key `tabs` by the canonical `/` spelling.
const CWD = resolve('/tmp')
const init = (): State => definition.init({ cwd: CWD } as never)
const key = (name: string): string => canonicalTabPath(resolve(CWD, name))

test('is versioned for the per-tab schema', () => {
  assert.equal(definition.stateVersion, 3)
})

function call(name: string, args: Record<string, unknown>, callId: string) {
  return { type: 'tool/call', data: { name, callId, arguments: JSON.stringify(args) } } as never
}

function result(callId: string) {
  return { type: 'tool/result', data: { message: { toolCallId: callId } } } as never
}

test('keys tabs with the canonical / spelling for a native absolute path', () => {
  let state = init()
  // `resolve` returns the Host-native spelling. On Windows that is a
  // backslash path, which must never become a projection key.
  state = definition.apply(state, call('mol_open', { path: resolve(CWD, 'a.pdb') }, 'a'))

  assert.deepEqual(Object.keys(state.tabs), [key('a.pdb')])
  assert.equal(state.active, key('a.pdb'))
  assert.equal(key('a.pdb').includes('\\'), false)
})

test('keeps independent scenes and commands per tab', () => {
  let state = init()
  state = definition.apply(state, call('mol_open', { path: 'a.pdb' }, 'a'))
  state = definition.apply(state, call('mol_open', { path: 'b.pdb' }, 'b'))

  assert.deepEqual(Object.keys(state.tabs), [key('a.pdb'), key('b.pdb')])
  assert.equal(state.active, key('b.pdb'))
  assert.equal(state.tabs[key('a.pdb')]?.commands.length, 1)

  state = definition.apply(state, call('mol_style', {
    tab: key('a.pdb'),
    color: 'uniform',
    colorParams: { value: 0xff0000 },
  }, 'style-a'))
  assert.equal(state.tabs[key('a.pdb')]?.commands.length, 2)
  assert.equal(state.tabs[key('b.pdb')]?.commands.length, 1)

  state = definition.apply(state, call('mol_measure', {
    tab: key('a.pdb'),
    kind: 'distance',
    targets: [
      { kind: 'residue', chain: 'A', index: 33 },
      { kind: 'residue', chain: 'B', index: 73 },
    ],
  }, 'measure-a'))
  assert.equal(state.tabs[key('a.pdb')]?.commands.length, 3)
  assert.equal(state.tabs[key('b.pdb')]?.commands.length, 1)
})

test('a tab argument in either separator spelling hits the same tab', () => {
  let state = init()
  state = definition.apply(state, call('mol_open', { path: key('a.pdb') }, 'a'))
  // On POSIX both spellings are identical; on Windows this is the issue 13
  // regression where a native `D:\…` tab argument missed the `/` key.
  state = definition.apply(state, call('mol_style', { tab: resolve(CWD, 'a.pdb'), color: 'uniform' }, 'native'))

  assert.equal(state.tabs[key('a.pdb')]?.commands.length, 2)
})

test('normalizes named colour params and rejects unresolvable colours', () => {
  let state = init()
  state = definition.apply(state, call('mol_open', {
    path: 'a.pdb',
    color: 'uniform',
    colorParams: { value: 'red' },
  }, 'a'))
  const style = state.tabs[key('a.pdb')]?.commands[0]
  if (style?.op !== 'represent') assert.fail('expected a represent command')
  assert.equal(style.style.colorParams?.value, 0xff0000)

  const before = state
  state = definition.apply(state, call('mol_style', {
    tab: key('a.pdb'),
    color: 'uniform',
    colorParams: { value: 'not-a-colour' },
  }, 'bad-style'))
  assert.equal(state, before)

  const fresh = init()
  const unchanged = definition.apply(fresh, call('mol_open', {
    path: 'b.pdb',
    color: 'uniform',
    colorParams: { value: 'not-a-colour' },
  }, 'bad-open'))
  assert.equal(unchanged, fresh)
})

test('folds an explicit replace flag and leaves the core default otherwise', () => {
  let state = init()
  state = definition.apply(state, call('mol_open', { path: 'a.pdb' }, 'a'))
  state = definition.apply(state, call('mol_style', {
    tab: key('a.pdb'),
    type: 'ball-and-stick',
    target: { kind: 'residues', chain: 'A', start: 1, end: 5 },
    replace: false,
  }, 'overlay'))
  const overlay = state.tabs[key('a.pdb')]?.commands[1]
  if (overlay?.op !== 'represent') assert.fail('expected a represent command')
  assert.equal(overlay.replace, false)
  assert.deepEqual(overlay.target, { kind: 'residues', chain: 'A', start: 1, end: 5 })

  state = definition.apply(state, call('mol_style', {
    tab: key('a.pdb'),
    type: 'cartoon',
    target: { kind: 'ligand' },
  }, 'default-replace'))
  const defaulted = state.tabs[key('a.pdb')]?.commands[2]
  if (defaulted?.op !== 'represent') assert.fail('expected a represent command')
  assert.equal('replace' in defaulted, false, 'omitted replace must fall back to the core default')
})

test('capture targets the requested tab and clears on result', () => {
  let state = init()
  state = definition.apply(state, call('mol_open', { path: 'a.pdb' }, 'a'))
  state = definition.apply(state, call('mol_open', { path: 'b.pdb' }, 'b'))
  state = definition.apply(state, call('mol_capture', { tab: key('a.pdb'), width: 640 }, 'shot'))

  assert.equal(state.pending.shot?.path, key('a.pdb'))
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
  state = definition.apply(state, call('mol_style', { tab: key('missing.pdb') }, 'missing'))
  assert.equal(state, before)

  state = definition.apply(state, call('mol_open', { path: 'bad.pdb', select: { kind: 'bogus' } }, 'bad'))
  assert.equal(state, before)

  state = definition.apply(state, call('mol_measure', {
    tab: key('a.pdb'),
    kind: 'angle',
    targets: [{ kind: 'residue', chain: 'A', index: 1 }, { kind: 'residue', chain: 'A', index: 2 }],
  }, 'angle'))
  assert.equal(state.tabs[key('a.pdb')]?.commands.length, 1)

  state = definition.apply(state, call('mol_measure', {
    tab: key('a.pdb'),
    kind: 'distance',
    targets: [{ kind: 'ligand' }, { kind: 'protein' }],
  }, 'semantic'))
  assert.equal(state.tabs[key('a.pdb')]?.commands.length, 1)

  assert.equal(definition.apply(state, result('unrelated')), state)
})

test('defaults to the active tab and reopens the same path in place', () => {
  let state = init()
  state = definition.apply(state, call('mol_open', { path: 'a.pdb' }, 'a1'))
  state = definition.apply(state, call('mol_open', { path: 'b.pdb' }, 'b1'))

  state = definition.apply(state, call('mol_style', { color: 'uniform', colorParams: { value: 0xff0000 } }, 'style-active'))
  assert.equal(state.tabs[key('a.pdb')]?.commands.length, 1)
  assert.equal(state.tabs[key('b.pdb')]?.commands.length, 2)

  state = definition.apply(state, call('mol_open', { path: 'a.pdb' }, 'a2'))
  assert.equal(Object.keys(state.tabs).length, 2)
  assert.equal(state.tabs[key('a.pdb')]?.sceneKey, `${key('a.pdb')}#a2`)
  assert.equal(state.tabs[key('a.pdb')]?.commands.length, 1)
  assert.equal(state.active, key('a.pdb'))
})
