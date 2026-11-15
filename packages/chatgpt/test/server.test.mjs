import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from '../lib/server.js'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const repoRoot = resolve(packageRoot, '../..')
const fixture = join(repoRoot, 'fixtures/1crn.pdb')
const aspirin = join(repoRoot, 'fixtures/aspirin.sdf')
const onePixelPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

async function withClient(t, options = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'mol4agent-test-'))
  process.env.MOL4AGENT_CWD = workspace
  const server = await createServer({
    viewerHtml: '<!doctype html><html><body>test viewer</body></html>',
    captureTimeoutMs: 4000,
    ...options,
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'mol4agent-test', version: '0.0.0' }, { capabilities: {} })
  await client.connect(clientTransport)
  t.after(async () => {
    await client.close()
    await server.close()
    delete process.env.MOL4AGENT_CWD
    await rm(workspace, { recursive: true, force: true })
  })
  return { client, workspace, server }
}

test('lists the agent tools and the viewer resource', async t => {
  const { client } = await withClient(t)
  const { tools } = await client.listTools()
  const names = tools.map(tool => tool.name)
  for (const expected of [
    'mol_info',
    'mol_interface',
    'mol_open',
    'mol_style',
    'mol_select',
    'mol_focus',
    'mol_measure',
    'mol_capture',
    'mol_viewer_poll',
    'mol_capture_deliver',
    'mol_capture_fail',
  ]) {
    assert.ok(names.includes(expected), `missing tool ${expected}`)
  }

  const open = tools.find(tool => tool.name === 'mol_open')
  assert.equal(open?._meta?.ui?.resourceUri, 'ui://mol4agent/viewer.html')

  const poll = tools.find(tool => tool.name === 'mol_viewer_poll')
  assert.deepEqual(poll?._meta?.ui?.visibility, ['app'])

  const { resources } = await client.listResources()
  assert.ok(resources.some(resource => resource.uri === 'ui://mol4agent/viewer.html'))
})

test('summarizes a PDB and renders its chains', async t => {
  const { client } = await withClient(t)
  const result = await client.callTool({ name: 'mol_info', arguments: { path: fixture } })
  assert.equal(result.isError, undefined)
  const text = result.content.find(block => block.type === 'text')?.text ?? ''
  assert.match(text, /1crn\.pdb/)
  assert.match(text, /chains:/)
  assert.match(text, /residues:/)
})

test('opens a scene, reads its bytes, and appends commands', async t => {
  const { client } = await withClient(t)
  const opened = await client.callTool({
    name: 'mol_open',
    arguments: { path: fixture, type: 'cartoon', color: 'chain-id' },
  })
  assert.equal(opened.isError, undefined)
  const scene = opened.structuredContent?.scene
  assert.equal(scene.label, '1crn.pdb')
  assert.equal(scene.format, 'pdb')
  assert.equal(scene.commands.length, 1)
  assert.deepEqual(scene.commands[0], {
    op: 'represent',
    style: { type: 'cartoon', color: 'chain-id' },
  })

  const resource = await client.readResource({ uri: `mol4agent://structure/${scene.sceneId}` })
  const content = resource.contents[0]
  assert.equal(content.mimeType, 'text/plain')
  assert.match(content.text, /^HEADER/m)
  assert.match(content.text, /ATOM  /)

  const styled = await client.callTool({
    name: 'mol_style',
    arguments: {
      type: 'ball-and-stick',
      color: 'uniform',
      colorParams: { value: 0xff0000 },
      target: { kind: 'residues', chain: 'A', start: 1, end: 5 },
    },
  })
  assert.equal(styled.isError, undefined)
  const next = styled.structuredContent?.scene
  assert.equal(next.revision, scene.revision + 1)
  assert.equal(next.commands.length, 2)
  assert.deepEqual(next.commands[1], {
    op: 'represent',
    style: { type: 'ball-and-stick', color: 'uniform', colorParams: { value: 0xff0000 } },
    target: { kind: 'residues', chain: 'A', start: 1, end: 5 },
  })

  const selected = await client.callTool({
    name: 'mol_select',
    arguments: { target: { kind: 'chain', chain: 'A' }, mode: 'highlight', focus: true },
  })
  assert.equal(selected.structuredContent?.scene.commands.length, 3)
  assert.deepEqual(selected.structuredContent?.scene.commands[2], {
    op: 'select',
    target: { kind: 'chain', chain: 'A' },
    mode: 'highlight',
    focus: true,
  })
})

test('opens an SDF and reports unsupported summaries gracefully', async t => {
  const { client } = await withClient(t)
  const opened = await client.callTool({ name: 'mol_open', arguments: { path: aspirin } })
  assert.equal(opened.isError, undefined)
  assert.equal(opened.structuredContent?.scene.format, 'sdf')
  const resource = await client.readResource({
    uri: `mol4agent://structure/${opened.structuredContent.scene.sceneId}`,
  })
  assert.match(resource.contents[0].text, /V2000/)
})

test('rejects malformed selectors and missing scenes', async t => {
  const { client } = await withClient(t)
  const noScene = await client.callTool({ name: 'mol_style', arguments: { type: 'cartoon' } })
  assert.equal(noScene.isError, true)
  assert.match(noScene.content[0].text, /open a structure with mol_open/)

  const opened = await client.callTool({ name: 'mol_open', arguments: { path: fixture } })
  assert.equal(opened.isError, undefined)
  const bad = await client.callTool({
    name: 'mol_select',
    arguments: { target: { kind: 'residues', chain: 'A', start: 'nope', end: 5 } },
  })
  assert.equal(bad.isError, true)
})

test('rendezvous: capture claim and PNG delivery', async t => {
  const { client, workspace } = await withClient(t)
  const opened = await client.callTool({ name: 'mol_open', arguments: { path: fixture } })
  const scene = opened.structuredContent.scene

  const capturePromise = client.callTool({
    name: 'mol_capture',
    arguments: { width: 320, height: 240 },
  })

  let poll
  for (let attempt = 0; attempt < 4; attempt += 1) {
    poll = await client.callTool({
      name: 'mol_viewer_poll',
      arguments: { sceneId: scene.sceneId, revision: scene.revision, timeoutMs: 1000 },
    })
    if (poll.structuredContent?.capture !== null) break
  }
  assert.ok(poll?.structuredContent?.capture, 'the app did not receive the capture request')
  assert.equal(poll.structuredContent.capture.width, 320)
  assert.equal(poll.structuredContent.capture.height, 240)

  const delivered = await client.callTool({
    name: 'mol_capture_deliver',
    arguments: {
      captureId: poll.structuredContent.capture.captureId,
      data: onePixelPng,
      width: 320,
      height: 240,
      diagnostics: { canvas: { width: 320, height: 240 } },
    },
  })
  assert.equal(delivered.isError, undefined)
  const savedPath = delivered.structuredContent?.path
  assert.ok(savedPath?.startsWith(join(workspace, '.mol4agent', 'captures')))
  assert.ok((await stat(savedPath)).size > 0)

  const captured = await capturePromise
  assert.equal(captured.isError, undefined)
  const image = captured.content.find(block => block.type === 'image')
  assert.equal(image?.mimeType, 'image/png')
  assert.equal(image?.data, onePixelPng)
})

test('capture times out with a model-readable error when no app claims it', async t => {
  const { client } = await withClient(t, { captureTimeoutMs: 350 })
  await client.callTool({ name: 'mol_open', arguments: { path: fixture } })
  const captured = await client.callTool({ name: 'mol_capture', arguments: {} })
  assert.equal(captured.isError, true)
  assert.match(captured.content[0].text, /did not deliver a screenshot in time/)
})

test('built viewer is a self-contained MCP App page', async () => {
  const html = await readFile(join(packageRoot, 'lib/viewer.html'), 'utf8')
  assert.ok(html.length > 1_000_000)
  assert.ok(html.length < 20_000_000)
  assert.ok(!html.includes('__MOL4AGENT_JS__'))
  assert.match(html, /<div id="app">/)
  assert.match(html, /mol4agent/)
})
