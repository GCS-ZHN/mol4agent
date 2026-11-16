import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

async function start(sessionRoot: string, fails = false): Promise<OpenPath> {
  let openPath: OpenPath | undefined
  const ctx = {
    app: { version: 'test' },
    session: {
      async get() {
        if (fails) throw new Error('session unavailable')
        return { location: { directory: sessionRoot } }
      },
    },
    rpc: {
      async register(_definition: unknown, handlers: Record<string, unknown>) {
        openPath = handlers.openPath as OpenPath
        return { events: { async emit() {} } }
      },
    },
    tool: {
      async transform(edit: (editor: { add(entry: unknown): void }) => void) {
        edit({ add() {} })
      },
    },
  }
  await server.setup(ctx as never)
  if (openPath === undefined) throw new Error('openPath was not registered')
  return openPath
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

test('openPath fails clearly when the session workspace is unknown', async () => {
  const cwd = await workspace()
  const openPath = await start(cwd, true)
  const result = await openPath({ path: 'example/1crn.pdb', sessionID: 'session-1' })
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /could not resolve the workspace directory for session session-1/u)
})
