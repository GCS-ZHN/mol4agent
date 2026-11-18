import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import server from '../src/server.ts'

const PDB = 'ATOM      1  N   ALA A   1       0.000   0.000   0.000  1.00  0.00           N\nEND\n'

let root = ''
after(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true })
})

type OpenPath = (input: { path: string; cwd?: string; base?: string; sessionID?: string }) => Promise<{
  ok: boolean
  path?: string
  tab?: string
  error?: string
}>

interface RegisteredTool {
  name: string
  execute(input: unknown, context: { sessionID: string; signal: AbortSignal }): Promise<{ content: string }>
}

type Handler = (input: unknown) => Promise<unknown>

interface Harness {
  readonly tools: Map<string, RegisteredTool>
  readonly handlers: Record<string, Handler>
  readonly events: Array<{ readonly name: string; readonly data: unknown }>
}

async function startHarness(sessionRoot: string, fails = false): Promise<Harness> {
  const tools = new Map<string, RegisteredTool>()
  const handlers: Record<string, Handler> = {}
  const events: Array<{ name: string; data: unknown }> = []
  const ctx = {
    app: { version: 'test' },
    session: {
      async get() {
        if (fails) throw new Error('session unavailable')
        return { location: { directory: sessionRoot } }
      },
    },
    rpc: {
      async register(_definition: unknown, registered: Record<string, unknown>) {
        for (const [name, handler] of Object.entries(registered)) {
          if (typeof handler === 'function') handlers[name] = handler as Handler
        }
        return {
          events: {
            async emit(name: string, data: unknown) { events.push({ name, data }) },
          },
        }
      },
    },
    tool: {
      async transform(edit: (editor: { add(entry: unknown): void }) => void) {
        edit({ add(entry) { const tool = entry as RegisteredTool; tools.set(tool.name, tool) } })
      },
    },
  }
  await server.setup(ctx as never)
  return { tools, handlers, events }
}

async function start(sessionRoot: string, fails = false): Promise<OpenPath> {
  const harness = await startHarness(sessionRoot, fails)
  const openPath = harness.handlers.openPath as OpenPath | undefined
  if (openPath === undefined) throw new Error('openPath was not registered')
  return openPath
}

async function startTools(sessionRoot: string): Promise<Map<string, RegisteredTool>> {
  return (await startHarness(sessionRoot)).tools
}

async function workspace(): Promise<string> {
  if (root === '') {
    root = await mkdtemp(join(tmpdir(), 'mol4agent-opencode-server-'))
    await mkdir(join(root, 'example'), { recursive: true })
    await writeFile(join(root, 'example', '1crn.pdb'), PDB)
  }
  return root
}

test('openPath resolves relative paths in the session workspace, not a client cwd', async () => {
  const cwd = await workspace()
  const openPath = await start(cwd)
  const result = await openPath({ path: 'example/1crn.pdb', cwd: '/client/wherever', sessionID: 'session-1' })
  assert.equal(result.ok, true)
  assert.equal(result.path, join(cwd, 'example', '1crn.pdb'))
})

test('openPath honors the link base for a relative path', async () => {
  const cwd = await workspace()
  const openPath = await start(cwd)
  const result = await openPath({ path: '1crn.pdb', base: 'example', sessionID: 'session-1' })
  assert.equal(result.ok, true)
  assert.equal(result.path, join(cwd, 'example', '1crn.pdb'))
})

test('openPath rejects a Windows path on a POSIX server instead of re-rooting it', { skip: process.platform === 'win32' }, async () => {
  const cwd = await workspace()
  const openPath = await start(cwd)
  const result = await openPath({ path: 'C:\\data\\corp\\example\\1crn.pdb', sessionID: 'session-1' })
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /Windows path, but the OpenCode server runs on POSIX/u)
  assert.doesNotMatch(result.error ?? '', /^cannot read /u)
})

test('mol_fetch downloads on the session server and reports the saved path', async () => {
  const cwd = await workspace()
  const tools = await startTools(cwd)
  const fetchTool = tools.get('mol_fetch')
  assert.ok(fetchTool, 'mol_fetch was not registered')

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(PDB, { status: 200 })
  try {
    const result = await fetchTool.execute(
      { entry_id: '1crn', target_path: 'downloads/1crn' },
      { sessionID: 'session-1', signal: new AbortController().signal },
    )
    const saved = join(cwd, 'downloads', '1crn.pdb')
    assert.ok(result.content.includes(`saved: ${saved}`), result.content)
    assert.match(result.content, /RCSB PDB entry 1CRN/u)
    assert.equal(await readFile(saved, 'utf8'), PDB)
  } finally {
    globalThis.fetch = originalFetch
    await rm(join(cwd, 'downloads'), { recursive: true, force: true })
  }
})

test('openPath fails clearly when the session workspace is unknown', async () => {
  const cwd = await workspace()
  const openPath = await start(cwd, true)
  const result = await openPath({ path: 'example/1crn.pdb', sessionID: 'session-1' })
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /could not resolve the workspace directory for session session-1/u)
})

interface SceneSnapshot {
  revision: number
  commands: Array<{
    op: string
    style?: { colorParams?: { value?: unknown } }
    target?: unknown
    replace?: boolean
  }>
}

interface SceneStoreLike {
  active(sessionID: string): string | null
  snapshot(sessionID: string, path: string | null): SceneSnapshot | null
}

function sceneStore(): SceneStoreLike {
  const g = globalThis as unknown as Record<string, unknown>
  return g['__mol4agent_opencode_state__store'] as SceneStoreLike
}

test('mol_open and mol_style normalize colors before storing the command', async () => {
  const cwd = await workspace()
  const tools = await startTools(cwd)
  const open = tools.get('mol_open')
  const style = tools.get('mol_style')
  assert.ok(open !== undefined && style !== undefined)
  const context = { sessionID: 'session-colour', signal: new AbortController().signal }

  await open.execute({ path: 'example/1crn.pdb', type: 'cartoon', color: 'uniform', colorParams: { value: 'red' } }, context)
  let snapshot = sceneStore().snapshot('session-colour', null)
  assert.equal(snapshot?.commands[0]?.style?.colorParams?.value, 0xff0000)

  const styled = await style.execute({ type: 'cartoon', color: 'uniform', colorParams: { value: '#00f' } }, context)
  assert.equal(styled.content, 'Applied cartoon / uniform #0000ff to the whole structure.')
  snapshot = sceneStore().snapshot('session-colour', null)
  assert.equal(snapshot?.commands[1]?.style?.colorParams?.value, 0x0000ff)
})

test('mol_style passes an explicit replace:false through to the scene log', async () => {
  const cwd = await workspace()
  const tools = await startTools(cwd)
  const open = tools.get('mol_open')
  const style = tools.get('mol_style')
  assert.ok(open !== undefined && style !== undefined)
  const context = { sessionID: 'session-overlay', signal: new AbortController().signal }

  await open.execute({ path: 'example/1crn.pdb', type: 'cartoon' }, context)
  const styled = await style.execute({
    type: 'ball-and-stick',
    target: { kind: 'residues', chain: 'A', start: 1, end: 5 },
    replace: false,
  }, context)
  assert.match(styled.content, /\(overlaid\)/u)
  const command = sceneStore().snapshot('session-overlay', null)?.commands[1]
  assert.equal(command?.replace, false)
  assert.deepEqual(command?.target, { kind: 'residues', chain: 'A', start: 1, end: 5 })
})

test('an invalid color is rejected before it reaches the scene log', async () => {
  const cwd = await workspace()
  const tools = await startTools(cwd)
  const open = tools.get('mol_open')
  const style = tools.get('mol_style')
  assert.ok(open !== undefined && style !== undefined)
  const context = { sessionID: 'session-bad-colour', signal: new AbortController().signal }

  await assert.rejects(
    open.execute({ path: 'example/1crn.pdb', color: 'uniform', colorParams: { value: 'not-a-colour' } }, context),
    /invalid color "not-a-colour"/u,
  )
  assert.equal(sceneStore().active('session-bad-colour'), null)

  await open.execute({ path: 'example/1crn.pdb', color: 'uniform', colorParams: { value: 'red' } }, context)
  const before = sceneStore().snapshot('session-bad-colour', null)?.revision
  await assert.rejects(
    style.execute({ color: 'uniform', colorParams: { value: 'not-a-colour' } }, context),
    /invalid color "not-a-colour"/u,
  )
  assert.equal(sceneStore().snapshot('session-bad-colour', null)?.revision, before)
  await assert.rejects(
    style.execute({ color: 'uniform', colorParams: 'red' as never }, context),
    /colorParams must be an object/u,
  )
})

const INSPECT_RESULT = {
  target: 'whole structure',
  detail: 'summary',
  atoms: 1,
  residues: 1,
  chains: 1,
  models: 1,
  counts: [{ compId: 'ALA', kind: 'polymer', residues: 1, atoms: 1 }],
  styles: [{ component: 'Structure', type: 'cartoon', color: 'chain-id', size: 'physical' }],
  truncated: false,
}

test('mol_inspect queues a query and formats the viewer answer', async () => {
  const cwd = await workspace()
  const harness = await startHarness(cwd)
  const open = harness.tools.get('mol_open')
  const inspect = harness.tools.get('mol_inspect')
  assert.ok(open !== undefined && inspect !== undefined, 'mol_inspect was not registered')
  const context = { sessionID: 'session-inspect', signal: new AbortController().signal }
  await open.execute({ path: 'example/1crn.pdb' }, context)

  const call = inspect.execute({ target: { kind: 'selection' }, detail: 'residues', limit: 10 }, context)
  const pending = (await harness.handlers.pendingInspections!({ sessionID: 'session-inspect' })) as {
    inspections: Array<{ inspectId: string; sceneId: string; path: string; target?: unknown; detail?: string; limit?: number }>
  }
  assert.equal(pending.inspections.length, 1)
  const asked = pending.inspections[0]!
  assert.deepEqual(asked.target, { kind: 'selection' })
  assert.equal(asked.detail, 'residues')
  assert.equal(asked.limit, 10)
  assert.equal(asked.path, join(cwd, 'example', '1crn.pdb'))
  assert.ok(harness.events.some(event => event.name === 'inspect' && (event.data as { inspectId?: string }).inspectId === asked.inspectId))

  const delivered = await harness.handlers.deliverInspect!({
    inspectId: asked.inspectId,
    ok: true,
    result: { ...INSPECT_RESULT, detail: 'residues', residueRows: [] },
  })
  assert.deepEqual(delivered, { ok: true })
  const result = await call
  assert.match(result.content, /<inspect target="whole structure" detail="residues">/u)
  assert.match(result.content, /- ALA \(polymer\): 1 residue, 1 atom/u)
  assert.deepEqual((await harness.handlers.pendingInspections!({ sessionID: 'session-inspect' })) as { inspections: unknown[] }, {
    inspections: [],
  })
})

test('mol_inspect reports a viewer failure as a normal result', async () => {
  const cwd = await workspace()
  const harness = await startHarness(cwd)
  const open = harness.tools.get('mol_open')
  const inspect = harness.tools.get('mol_inspect')
  assert.ok(open !== undefined && inspect !== undefined)
  const context = { sessionID: 'session-inspect-fail', signal: new AbortController().signal }
  await open.execute({ path: 'example/1crn.pdb' }, context)

  const call = inspect.execute({}, context)
  const pending = (await harness.handlers.pendingInspections!({ sessionID: 'session-inspect-fail' })) as {
    inspections: Array<{ inspectId: string }>
  }
  await harness.handlers.deliverInspect!({
    inspectId: pending.inspections[0]!.inspectId,
    ok: false,
    message: 'no structure is loaded',
  })
  const result = await call
  assert.equal(result.content, 'Could not inspect 1crn.pdb: no structure is loaded')
})

test('mol_inspect rejects unusable arguments before queueing', async () => {
  const cwd = await workspace()
  const harness = await startHarness(cwd)
  const open = harness.tools.get('mol_open')
  const inspect = harness.tools.get('mol_inspect')
  assert.ok(open !== undefined && inspect !== undefined)
  const context = { sessionID: 'session-inspect-bad', signal: new AbortController().signal }

  await assert.rejects(inspect.execute({}, context), /open a structure with mol_open/u)
  await open.execute({ path: 'example/1crn.pdb' }, context)
  await assert.rejects(inspect.execute({ detail: 'everything' }, context), /detail must be one of/u)
  await assert.rejects(inspect.execute({ limit: 0 }, context), /limit must be a positive integer/u)
  await assert.rejects(inspect.execute({ target: { kind: 'bogus' } }, context), /selector "kind" must be one of/u)
  await assert.rejects(
    inspect.execute({ target: { kind: 'chain', chain: 'Z' } }, context),
    /chain "Z" does not exist/u,
  )
  const pending = (await harness.handlers.pendingInspections!({ sessionID: 'session-inspect-bad' })) as { inspections: unknown[] }
  assert.deepEqual(pending.inspections, [], 'no query survives validation')
})

test('deliverInspect rejects a malformed answer and keeps the query pending', async () => {
  const cwd = await workspace()
  const harness = await startHarness(cwd)
  const open = harness.tools.get('mol_open')
  const inspect = harness.tools.get('mol_inspect')
  assert.ok(open !== undefined && inspect !== undefined)
  const context = { sessionID: 'session-inspect-malformed', signal: new AbortController().signal }
  await open.execute({ path: 'example/1crn.pdb' }, context)

  const call = inspect.execute({}, context)
  const pending = (await harness.handlers.pendingInspections!({ sessionID: 'session-inspect-malformed' })) as {
    inspections: Array<{ inspectId: string }>
  }
  const inspectId = pending.inspections[0]!.inspectId
  assert.deepEqual(await harness.handlers.deliverInspect!({ inspectId, ok: true, result: {} }), { ok: false })
  assert.equal(
    ((await harness.handlers.pendingInspections!({ sessionID: 'session-inspect-malformed' })) as { inspections: unknown[] }).inspections.length,
    1,
  )
  assert.deepEqual(await harness.handlers.deliverInspect!({ inspectId, ok: true, result: INSPECT_RESULT }), { ok: true })
  const result = await call
  assert.match(result.content, /<inspect target="whole structure" detail="summary">/u)
})

const PD_L1 = fileURLToPath(new URL('../../../fixtures/7czd.pdb', import.meta.url))
const PD_1 = fileURLToPath(new URL('../../../fixtures/4zqk.pdb', import.meta.url))

test('mol_add_structure and mol_list_structures expose a second structure', async () => {
  const cwd = await workspace()
  const harness = await startHarness(cwd)
  const open = harness.tools.get('mol_open')
  const add = harness.tools.get('mol_add_structure')
  const list = harness.tools.get('mol_list_structures')
  assert.ok(open !== undefined && add !== undefined && list !== undefined)
  const context = { sessionID: 'session-add-structure', signal: new AbortController().signal }

  const opened = await open.execute({ path: PD_L1 }, context)
  assert.match(opened.content, /Primary structure id: "structure"/)
  const added = await add.execute({ path: PD_1, id: 'pd1' }, context)
  assert.match(added.content, /structure id "pd1"/)
  const listed = await list.execute({}, context)
  assert.match(listed.content, /- structure: 7czd\.pdb/)
  assert.match(listed.content, /- pd1: 4zqk\.pdb/)
})

test('mol_align appends a scoped command and waits for the viewer metrics', async () => {
  const cwd = await workspace()
  const harness = await startHarness(cwd)
  const open = harness.tools.get('mol_open')
  const add = harness.tools.get('mol_add_structure')
  const align = harness.tools.get('mol_align')
  assert.ok(open !== undefined && add !== undefined && align !== undefined)
  const context = { sessionID: 'session-align', signal: new AbortController().signal }
  await open.execute({ path: PD_L1 }, context)
  await add.execute({ path: PD_1, id: 'pd1' }, context)

  const call = align.execute({ reference: 'structure', target: 'pd1', referenceChain: 'B', targetChain: 'A' }, context)
  const scene = sceneStore().snapshot('session-align', null) as unknown as {
    sceneId: string
    commands: Array<{ op: string; reference?: string; target?: string }>
  }
  const index = scene.commands.findIndex(command => command.op === 'align')
  assert.ok(index >= 0)
  assert.deepEqual(
    { reference: scene.commands[index]?.reference, target: scene.commands[index]?.target },
    { reference: 'structure', target: 'pd1' },
  )
  const delivered = await harness.handlers.deliverAlign!({
    sceneId: scene.sceneId,
    commandIndex: index,
    ok: true,
    result: {
      method: 'tm-align',
      reference: 'structure',
      target: 'pd1',
      rmsd: 1,
      alignedLength: 115,
      tmScoreA: 0.88,
      tmScoreB: 0.95,
    },
  })
  assert.deepEqual(delivered, { ok: true })
  const result = await call
  assert.match(result.content, /TM-score 0\.8800\/0.9500/u)
  assert.match(result.content, /115 aligned residues/u)
})

test('mol_tmscore queues a read-only query and formats the answer', async () => {
  const cwd = await workspace()
  const harness = await startHarness(cwd)
  const open = harness.tools.get('mol_open')
  const add = harness.tools.get('mol_add_structure')
  const tmscore = harness.tools.get('mol_tmscore')
  assert.ok(open !== undefined && add !== undefined && tmscore !== undefined)
  const context = { sessionID: 'session-tmscore', signal: new AbortController().signal }
  await open.execute({ path: PD_L1 }, context)
  await add.execute({ path: PD_1, id: 'pd1' }, context)

  const call = tmscore.execute({
    reference: { kind: 'chain', chain: 'B', structureId: 'structure' },
    target: { kind: 'chain', chain: 'A', structureId: 'pd1' },
  }, context)
  const pending = (await harness.handlers.pendingTmScores!({ sessionID: 'session-tmscore' })) as {
    queries: Array<{ tmScoreId: string; sceneId: string }>
  }
  assert.equal(pending.queries.length, 1)
  await harness.handlers.deliverTmScore!({
    tmScoreId: pending.queries[0]!.tmScoreId,
    ok: true,
    result: {
      method: 'tm-align',
      reference: 'chain B [structure]',
      target: 'chain A [pd1]',
      rmsd: 1,
      tmScoreA: 0.8796,
      tmScoreB: 0.9527,
      alignedLength: 115,
      referenceAtoms: 125,
      targetAtoms: 115,
    },
  })
  const result = await call
  assert.match(result.content, /TM-score 0\.8796\/0\.9527/u)
  assert.match(result.content, /RMSD 1\.00 A/u)
})

test('mol_remove_structure retires a structure and rejects unknown ids', async () => {
  const cwd = await workspace()
  const harness = await startHarness(cwd)
  const open = harness.tools.get('mol_open')
  const add = harness.tools.get('mol_add_structure')
  const remove = harness.tools.get('mol_remove_structure')
  const list = harness.tools.get('mol_list_structures')
  assert.ok(open !== undefined && add !== undefined && remove !== undefined && list !== undefined)
  const context = { sessionID: 'session-remove', signal: new AbortController().signal }
  await open.execute({ path: PD_L1 }, context)
  await add.execute({ path: PD_1, id: 'pd1' }, context)
  const removed = await remove.execute({ structureId: 'pd1' }, context)
  assert.match(removed.content, /Removed structure "pd1"/u)
  const listed = await list.execute({}, context)
  assert.doesNotMatch(listed.content, /- pd1:/u)
  await assert.rejects(remove.execute({ structureId: 'missing' }, context), /no active structure/u)
})
