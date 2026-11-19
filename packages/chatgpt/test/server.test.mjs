import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from '../lib/server.js'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const repoRoot = resolve(packageRoot, '../..')
const fixture = join(repoRoot, 'fixtures/1crn.pdb')
const aspirin = join(repoRoot, 'fixtures/aspirin.sdf')
const gzipFixture = join(repoRoot, 'fixtures/formats/1crn.pdb.gz')
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
    'mol_workspace',
    'mol_interface',
    'mol_fetch',
    'mol_open',
    'mol_add_structure',
    'mol_list_structures',
    'mol_remove_structure',
    'mol_style',
    'mol_select',
    'mol_focus',
    'mol_measure',
    'mol_inspect',
    'mol_align',
    'mol_tmscore',
    'mol_capture',
    'mol_viewer_poll',
    'mol_capture_deliver',
    'mol_capture_fail',
    'mol_inspect_deliver',
    'mol_inspect_fail',
    'mol_tmscore_deliver',
    'mol_tmscore_fail',
    'mol_align_deliver',
  ]) {
    assert.ok(names.includes(expected), `missing tool ${expected}`)
  }

  const open = tools.find(tool => tool.name === 'mol_open')
  assert.equal(open?._meta?.ui?.resourceUri, 'ui://mol4agent/viewer.html')

  const poll = tools.find(tool => tool.name === 'mol_viewer_poll')
  assert.deepEqual(poll?._meta?.ui?.visibility, ['app'])

  const viewFile = tools.find(tool => tool.name === 'mol_view_file')
  assert.ok(viewFile)
  assert.ok(
    viewFile._meta?.['openai/ui']?.entrypoints?.some(
      entrypoint => entrypoint.type === 'file' && entrypoint.extensions.includes('.pdb'),
    ),
    'mol_view_file must declare a .pdb file handler',
  )
  assert.ok(
    viewFile._meta?.['openai/ui']?.entrypoints?.some(
      entrypoint => entrypoint.type === 'file' && entrypoint.extensions.includes('.pdb.gz'),
    ),
    'mol_view_file must declare a .pdb.gz file handler',
  )

  const { resources } = await client.listResources()
  assert.ok(resources.some(resource => resource.uri === 'ui://mol4agent/viewer.html'))
})

test('mol_capture reuses the open viewer instead of mounting another one', async t => {
  const { client } = await withClient(t)
  const { tools } = await client.listTools()

  const capture = tools.find(tool => tool.name === 'mol_capture')
  assert.ok(capture)
  assert.equal(
    capture._meta?.['openai/outputTemplate'],
    undefined,
    'mol_capture must not publish a viewer template; that mounts a second App card per capture',
  )
  assert.equal(capture._meta?.ui?.resourceUri, undefined)

  for (const name of ['mol_open', 'mol_view_file']) {
    const tool = tools.find(candidate => candidate.name === name)
    assert.equal(
      tool?._meta?.['openai/outputTemplate'],
      'ui://mol4agent/viewer.html',
      `${name} must still publish the viewer template`,
    )
  }
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

test('mol_fetch downloads a database entry and opens the saved file', async t => {
  const payload = await readFile(fixture)
  const requests = []
  const { client, workspace } = await withClient(t, {
    fetchImpl: async input => {
      requests.push(String(input))
      return new Response(payload, { status: 200 })
    },
  })

  const fetched = await client.callTool({
    name: 'mol_fetch',
    arguments: { entry_id: '1crn', target_path: 'models/1crn.pdb' },
  })
  assert.equal(fetched.isError, undefined)
  const text = fetched.content.find(block => block.type === 'text')?.text ?? ''
  assert.match(text, /RCSB PDB entry 1CRN/)
  assert.match(text, /chains:/)
  const target = join(workspace, 'models/1crn.pdb')
  assert.equal(fetched.structuredContent?.path, target)
  assert.equal(fetched.structuredContent?.format, 'pdb')
  assert.deepEqual(requests, ['https://files.rcsb.org/download/1CRN.pdb'])
  assert.deepEqual(new Uint8Array(await readFile(target)), new Uint8Array(payload))

  const opened = await client.callTool({ name: 'mol_open', arguments: { path: target } })
  assert.equal(opened.isError, undefined)
  assert.equal(opened.structuredContent?.scene.label, '1crn.pdb')
  assert.equal(opened.structuredContent?.scene.format, 'pdb')
})

test('mol_fetch rejects invalid entry ids and mismatched targets before downloading', async t => {
  const requests = []
  const { client } = await withClient(t, {
    fetchImpl: async input => {
      requests.push(String(input))
      return new Response('unexpected', { status: 500 })
    },
  })

  const badId = await client.callTool({
    name: 'mol_fetch',
    arguments: { entry_id: 'not-a-pdb-id', target_path: 'x.pdb' },
  })
  assert.equal(badId.isError, true)
  assert.match(badId.content[0].text, /not a PDB entry id/)

  const badTarget = await client.callTool({
    name: 'mol_fetch',
    arguments: { entry_id: '1crn', target_path: 'x.cif' },
  })
  assert.equal(badTarget.isError, true)
  assert.match(badTarget.content[0].text, /maps to mmcif/)

  assert.deepEqual(requests, [])
})

test('reports how the workspace root was resolved', async t => {
  const { client } = await withClient(t)
  const result = await client.callTool({ name: 'mol_workspace', arguments: {} })
  assert.equal(result.isError, undefined)
  assert.equal(typeof result.structuredContent?.root, 'string')
  assert.ok(['env', 'roots', 'cwd'].includes(result.structuredContent?.source))
})

test('opens a scene, reads its bytes, and appends commands', async t => {
  const { client } = await withClient(t)
  const opened = await client.callTool({
    name: 'mol_open',
    arguments: { path: fixture, type: 'cartoon', color: 'chain-id' },
  })
  assert.equal(opened.isError, undefined)
  const scene = opened.structuredContent?.scene
  assert.equal(scene.source, 'agent')
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

test('passes replace:false through for additive targeted styling', async t => {
  const { client } = await withClient(t)
  const opened = await client.callTool({
    name: 'mol_open',
    arguments: { path: fixture, type: 'cartoon', color: 'chain-id' },
  })
  assert.equal(opened.isError, undefined)

  const styled = await client.callTool({
    name: 'mol_style',
    arguments: {
      type: 'ball-and-stick',
      color: 'uniform',
      colorParams: { value: 0xff0000 },
      target: { kind: 'residues', chain: 'A', start: 1, end: 5 },
      replace: false,
    },
  })
  assert.equal(styled.isError, undefined)
  const commands = styled.structuredContent?.scene.commands
  assert.deepEqual(commands.at(-1), {
    op: 'represent',
    style: { type: 'ball-and-stick', color: 'uniform', colorParams: { value: 0xff0000 } },
    target: { kind: 'residues', chain: 'A', start: 1, end: 5 },
    replace: false,
  })
  assert.match(styled.content[0].text, /\(overlaid\)/)
})

test('rejects selectors that cannot match the structure', async t => {
  const { client } = await withClient(t)
  const opened = await client.callTool({ name: 'mol_open', arguments: { path: fixture } })
  assert.equal(opened.isError, undefined)

  const badChain = await client.callTool({
    name: 'mol_style',
    arguments: { type: 'cartoon', target: { kind: 'chain', chain: 'Z' } },
  })
  assert.equal(badChain.isError, true)
  assert.match(badChain.content[0].text, /chain "Z" does not exist/)

  const badComp = await client.callTool({
    name: 'mol_select',
    arguments: { target: { kind: 'comp', compId: 'NOPE' } },
  })
  assert.equal(badComp.isError, true)
  assert.match(badComp.content[0].text, /component "NOPE" does not exist/)

  const badResidueChain = await client.callTool({
    name: 'mol_style',
    arguments: {
      type: 'cartoon',
      target: { kind: 'residues', chain: 'Z', start: 28, end: 54 },
    },
  })
  assert.equal(badResidueChain.isError, true)
  assert.match(badResidueChain.content[0].text, /chain "Z" does not exist/)

  const badMeasure = await client.callTool({
    name: 'mol_measure',
    arguments: {
      kind: 'distance',
      targets: [{ kind: 'ligand' }, { kind: 'ligand' }],
    },
  })
  assert.equal(badMeasure.isError, true)
  assert.match(badMeasure.content[0].text, /must be chain\/residue\/residues\/comp\/schema/)

  const badRange = await client.callTool({
    name: 'mol_select',
    arguments: { target: { kind: 'residues', chain: 'A', start: 900, end: 910 } },
  })
  assert.equal(badRange.isError, true)
  assert.match(badRange.content[0].text, /do not intersect chain A/)

  const badOpen = await client.callTool({
    name: 'mol_open',
    arguments: { path: fixture, select: { kind: 'chain', chain: 'Z' } },
  })
  assert.equal(badOpen.isError, true)
  assert.match(badOpen.content[0].text, /chain "Z" does not exist/)
})

test('normalizes colour params and rejects unparseable colours', async t => {
  const { client } = await withClient(t)
  const opened = await client.callTool({
    name: 'mol_open',
    arguments: { path: fixture, color: 'uniform', colorParams: { value: 'red' } },
  })
  assert.equal(opened.isError, undefined)
  const scene = opened.structuredContent?.scene
  assert.deepEqual(scene.commands[0], {
    op: 'represent',
    style: { color: 'uniform', colorParams: { value: 0xff0000 } },
  })

  const styled = await client.callTool({
    name: 'mol_style',
    arguments: {
      type: 'cartoon',
      color: 'uniform',
      colorParams: { value: '#00ff00' },
      target: { kind: 'polymer' },
    },
  })
  assert.equal(styled.isError, undefined)
  assert.match(styled.content[0].text, /Applied cartoon \/ uniform #00ff00 to polymer\./)
  const next = styled.structuredContent?.scene
  assert.deepEqual(next.commands.at(-1).style.colorParams, { value: 0x00ff00 })

  const badStyle = await client.callTool({
    name: 'mol_style',
    arguments: { color: 'uniform', colorParams: { value: 'not-a-colour' } },
  })
  assert.equal(badStyle.isError, true)
  assert.match(badStyle.content[0].text, /invalid color "not-a-colour"/)

  // The rejected call must not append a command or bump the revision.
  const after = await client.callTool({
    name: 'mol_style',
    arguments: { type: 'cartoon' },
  })
  assert.equal(after.structuredContent?.scene.revision, next.revision + 1)
  assert.equal(after.structuredContent?.scene.commands.length, next.commands.length + 1)

  const badOpen = await client.callTool({
    name: 'mol_open',
    arguments: { path: fixture, color: 'uniform', colorParams: { value: 'not-a-colour' } },
  })
  assert.equal(badOpen.isError, true)
  assert.match(badOpen.content[0].text, /invalid color "not-a-colour"/)
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

test('opens gzip structures and serves decoded bytes', async t => {
  const { client } = await withClient(t)
  const info = await client.callTool({ name: 'mol_info', arguments: { path: gzipFixture } })
  assert.equal(info.isError, undefined)
  assert.match(info.content[0].text, /1crn\.pdb\.gz/)
  assert.match(info.content[0].text, /residues:/)

  const opened = await client.callTool({ name: 'mol_open', arguments: { path: gzipFixture } })
  assert.equal(opened.isError, undefined)
  const scene = opened.structuredContent?.scene
  assert.equal(scene.label, '1crn.pdb.gz')
  assert.equal(scene.format, 'pdb')
  assert.equal(scene.fileResourceUri, undefined)
  assert.equal(scene.fileGzip, undefined)

  const resource = await client.readResource({ uri: `mol4agent://structure/${scene.sceneId}` })
  assert.match(resource.contents[0].text, /^HEADER/m)
  assert.match(resource.contents[0].text, /ATOM  /)
})

test('rejects gzip payloads whose decoded size exceeds the limit', async t => {
  const { client } = await withClient(t, { maxFileBytes: 12_000 })
  const info = await client.callTool({ name: 'mol_info', arguments: { path: gzipFixture } })
  assert.equal(info.isError, true)
  assert.match(info.content[0].text, /cannot decompress/)
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

test('file viewer creates a host-resource scene and a direct scene', async t => {
  const { client } = await withClient(t)
  const hostScene = await client.callTool({
    name: 'mol_view_file',
    arguments: {
      file: { name: '1crn.pdb', resourceUri: 'codex-resource://test-file-viewer' },
    },
  })
  assert.equal(hostScene.isError, undefined)
  assert.equal(hostScene.structuredContent?.scene.format, 'pdb')
  assert.equal(hostScene.structuredContent?.scene.source, 'file')
  assert.equal(hostScene.structuredContent?.scene.fileResourceUri, 'codex-resource://test-file-viewer')
  assert.equal(hostScene.structuredContent?.scene.commands[0].op, 'represent')

  const directScene = await client.callTool({
    name: 'mol_view_file',
    arguments: { file: { name: fixture } },
  })
  assert.equal(directScene.isError, undefined)
  assert.equal(directScene.structuredContent?.scene.label, '1crn.pdb')
  assert.equal(directScene.structuredContent?.scene.source, 'file')
  assert.equal(directScene.structuredContent?.scene.fileResourceUri, undefined)

  const metadataScene = await client.callTool({
    name: 'mol_view_file',
    arguments: {
      file: { name: '1crn.pdb', resourceUri: 'codex-resource://test-file-viewer' },
    },
    _meta: { 'openai/file': { path: fixture } },
  })
  assert.equal(metadataScene.isError, undefined)
  assert.equal(metadataScene.structuredContent?.scene.fileResourceUri, undefined)
  assert.equal(metadataScene.structuredContent?.scene.source, 'file')
  const shared = await client.readResource({
    uri: `mol4agent://structure/${metadataScene.structuredContent.scene.sceneId}`,
  })
  assert.match(shared.contents[0].text, /ATOM  /)
})

test('file viewer decodes gzip blobs and marks raw host resources', async t => {
  const { client } = await withClient(t)
  const gzipBase64 = (await readFile(gzipFixture)).toString('base64')
  const blobScene = await client.callTool({
    name: 'mol_view_file',
    arguments: { file: { name: '1crn.pdb.gz', blob: gzipBase64 } },
  })
  assert.equal(blobScene.isError, undefined)
  assert.equal(blobScene.structuredContent?.scene.format, 'pdb')
  assert.equal(blobScene.structuredContent?.scene.fileGzip, undefined)
  const decoded = await client.readResource({
    uri: `mol4agent://structure/${blobScene.structuredContent.scene.sceneId}`,
  })
  assert.match(decoded.contents[0].text, /^HEADER/m)

  const hostScene = await client.callTool({
    name: 'mol_view_file',
    arguments: {
      file: { name: '1crn.pdb.gz', resourceUri: 'codex-resource://gzip-file-viewer' },
    },
  })
  assert.equal(hostScene.isError, undefined)
  assert.equal(hostScene.structuredContent?.scene.fileResourceUri, 'codex-resource://gzip-file-viewer')
  assert.equal(hostScene.structuredContent?.scene.fileGzip, true)

  const directScene = await client.callTool({
    name: 'mol_view_file',
    arguments: { file: { name: gzipFixture } },
  })
  assert.equal(directScene.isError, undefined)
  assert.equal(directScene.structuredContent?.scene.fileGzip, undefined)
  const shared = await client.readResource({
    uri: `mol4agent://structure/${directScene.structuredContent.scene.sceneId}`,
  })
  assert.match(shared.contents[0].text, /ATOM  /)
})

test('keeps every agent or file-viewer tab on its own scene', async t => {
  const { client } = await withClient(t)
  const agentA = await client.callTool({ name: 'mol_open', arguments: { path: fixture } })
  const agentAScene = agentA.structuredContent.scene
  const fileF = await client.callTool({
    name: 'mol_view_file',
    arguments: { file: { name: fixture } },
  })
  const fileFScene = fileF.structuredContent.scene
  assert.equal(agentAScene.source, 'agent')
  assert.equal(fileFScene.source, 'file')
  assert.notEqual(agentAScene.sceneId, fileFScene.sceneId)

  const agentB = await client.callTool({ name: 'mol_open', arguments: { path: aspirin } })
  const agentBScene = agentB.structuredContent.scene
  assert.equal(agentBScene.source, 'agent')
  assert.notEqual(agentBScene.sceneId, agentAScene.sceneId)

  // The older agent tab must not jump to the newly opened agent scene.
  const oldAgentPoll = await client.callTool({
    name: 'mol_viewer_poll',
    arguments: { sceneId: agentAScene.sceneId, revision: agentAScene.revision, mode: 'agent', timeoutMs: 1000 },
  })
  assert.equal(oldAgentPoll.structuredContent.scene.sceneId, agentAScene.sceneId)

  // The file tab must remain on its file scene.
  const filePoll = await client.callTool({
    name: 'mol_viewer_poll',
    arguments: { sceneId: fileFScene.sceneId, revision: fileFScene.revision, mode: 'file', timeoutMs: 1000 },
  })
  assert.equal(filePoll.structuredContent.scene.sceneId, fileFScene.sceneId)

  // Agent styling only mutates the active agent scene, never the file scene.
  await client.callTool({ name: 'mol_style', arguments: { type: 'ball-and-stick' } })
  const fileAfterStyle = await client.callTool({
    name: 'mol_viewer_poll',
    arguments: { sceneId: fileFScene.sceneId, revision: fileFScene.revision, mode: 'file', timeoutMs: 1000 },
  })
  assert.equal(fileAfterStyle.structuredContent.scene.sceneId, fileFScene.sceneId)
  assert.equal(fileAfterStyle.structuredContent.scene.commands.length, fileFScene.commands.length)

  const agentBPoll = await client.callTool({
    name: 'mol_viewer_poll',
    arguments: { sceneId: agentBScene.sceneId, revision: agentBScene.revision, mode: 'agent', timeoutMs: 1000 },
  })
  assert.equal(agentBPoll.structuredContent.scene.sceneId, agentBScene.sceneId)
  assert.ok(agentBPoll.structuredContent.scene.revision > agentBScene.revision)

  // A file tab must not steal the agent scene's pending capture.
  const capturePromise = client.callTool({
    name: 'mol_capture',
    arguments: { width: 320, height: 240 },
  })
  const fileCapturePoll = await client.callTool({
    name: 'mol_viewer_poll',
    arguments: { sceneId: fileFScene.sceneId, revision: fileFScene.revision, mode: 'file', timeoutMs: 1000 },
  })
  assert.equal(fileCapturePoll.structuredContent.capture, null)

  const agentCapturePoll = await client.callTool({
    name: 'mol_viewer_poll',
    arguments: {
      sceneId: agentBScene.sceneId,
      revision: agentBPoll.structuredContent.scene.revision,
      mode: 'agent',
      timeoutMs: 1000,
    },
  })
  assert.ok(agentCapturePoll.structuredContent.capture)
  await client.callTool({
    name: 'mol_capture_deliver',
    arguments: {
      captureId: agentCapturePoll.structuredContent.capture.captureId,
      data: onePixelPng,
      width: 320,
      height: 240,
    },
  })
  const captured = await capturePromise
  assert.equal(captured.isError, undefined)
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

test('adds, lists, and removes structures in one scene', async t => {
  const { client } = await withClient(t)
  const opened = await client.callTool({ name: 'mol_open', arguments: { path: fixture } })
  const scene = opened.structuredContent.scene
  assert.deepEqual(scene.structures.map(structure => structure.id), ['structure'])

  const added = await client.callTool({
    name: 'mol_add_structure',
    arguments: { path: join(repoRoot, 'fixtures/4zqk.pdb'), id: 'pdl1', type: 'cartoon', color: 'chain-id' },
  })
  assert.equal(added.isError, undefined)
  const addedScene = added.structuredContent.scene
  assert.deepEqual(addedScene.structures.map(structure => structure.id), ['structure', 'pdl1'])
  assert.deepEqual(addedScene.commands.at(-1), {
    op: 'represent',
    style: { type: 'cartoon', color: 'chain-id' },
    target: { kind: 'all', structureId: 'pdl1' },
  })

  const listed = await client.callTool({ name: 'mol_list_structures', arguments: {} })
  assert.match(listed.content[0].text, /structure: 1crn\.pdb/)
  assert.match(listed.content[0].text, /pdl1: 4zqk\.pdb/)

  const duplicate = await client.callTool({
    name: 'mol_add_structure',
    arguments: { path: join(repoRoot, 'fixtures/4zqk.pdb'), id: 'pdl1' },
  })
  assert.equal(duplicate.isError, true)
  assert.match(duplicate.content[0].text, /already used/)

  const removed = await client.callTool({
    name: 'mol_remove_structure',
    arguments: { structureId: 'pdl1' },
  })
  assert.equal(removed.isError, undefined)
  assert.deepEqual(removed.structuredContent.scene.commands.at(-1), {
    op: 'remove-structure',
    structureId: 'pdl1',
  })

  const after = await client.callTool({ name: 'mol_list_structures', arguments: {} })
  assert.doesNotMatch(after.content[0].text, /pdl1:/)

  const scoped = await client.callTool({
    name: 'mol_style',
    arguments: { target: { kind: 'chain', chain: 'A', structureId: 'missing' } },
  })
  assert.equal(scoped.isError, true)
  assert.match(scoped.content[0].text, /no active structure with id "missing"/)
})

test('rendezvous: inspection answer with appearance and selection groups', async t => {
  const { client } = await withClient(t, { inspectTimeoutMs: 4000 })
  const opened = await client.callTool({ name: 'mol_open', arguments: { path: fixture } })
  const scene = opened.structuredContent.scene

  const pending = client.callTool({
    name: 'mol_inspect',
    arguments: { target: { kind: 'selection' }, detail: 'residues', limit: 5 },
  })
  let poll
  for (let attempt = 0; attempt < 4; attempt += 1) {
    poll = await client.callTool({
      name: 'mol_viewer_poll',
      arguments: { sceneId: scene.sceneId, revision: scene.revision, timeoutMs: 1000 },
    })
    if (poll.structuredContent?.inspect !== null) break
  }
  assert.ok(poll?.structuredContent?.inspect)
  const inspect = poll.structuredContent.inspect
  assert.deepEqual(inspect.request, {
    target: { kind: 'selection' },
    detail: 'residues',
    limit: 5,
  })

  const result = {
    target: 'selection',
    detail: 'residues',
    atoms: 43,
    residues: 5,
    chains: 1,
    models: 1,
    counts: [{ compId: 'ASP', kind: 'polymer', residues: 1, atoms: 8 }],
    residueRows: [{
      chain: 'E',
      seqId: 44,
      labelSeqId: 44,
      compId: 'ASP',
      kind: 'polymer',
      atoms: 8,
      x: 1,
      y: 2,
      z: 3,
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
      atoms: 60,
      residues: 7,
      groups: [{ atoms: 43, residues: 5 }, { atoms: 17, residues: 2 }],
    },
    truncated: false,
  }
  const data = gzipSync(Buffer.from(JSON.stringify({ ok: true, result }))).toString('base64')
  await client.callTool({
    name: 'mol_inspect_deliver',
    arguments: { queryId: inspect.queryId, data },
  })

  const inspected = await pending
  assert.equal(inspected.isError, undefined)
  assert.equal(inspected.structuredContent, undefined)
  const text = inspected.content[0].text
  assert.match(text, /selection: 2 entries, 7 residues, 60 atoms \(entries: 5 residues\/43 atoms, 2 residues\/17 atoms\)/)
  assert.match(text, /base #1b9e77 -> visible #22bb5b/)
  assert.match(text, /- selection #33ff1a strength 0\.3 on selection/)
})

test('rendezvous: alignment metrics and read-only TM-score', async t => {
  const { client } = await withClient(t, { alignTimeoutMs: 4000, tmScoreTimeoutMs: 4000 })
  const opened = await client.callTool({ name: 'mol_open', arguments: { path: fixture } })
  const scene = opened.structuredContent.scene
  await client.callTool({
    name: 'mol_add_structure',
    arguments: { path: join(repoRoot, 'fixtures/4zqk.pdb'), id: 'pdl1' },
  })

  const alignPromise = client.callTool({
    name: 'mol_align',
    arguments: { reference: 'structure', target: 'pdl1', method: 'tm-align' },
  })
  let poll
  for (let attempt = 0; attempt < 4; attempt += 1) {
    poll = await client.callTool({
      name: 'mol_viewer_poll',
      arguments: { sceneId: scene.sceneId, revision: scene.revision, timeoutMs: 1000 },
    })
    if (poll.structuredContent?.scene?.commands.some(command => command.op === 'align')) break
  }
  const polledScene = poll.structuredContent.scene
  const commandIndex = polledScene.commands.findIndex(command => command.op === 'align')
  assert.ok(commandIndex >= 0)
  const alignment = {
    method: 'tm-align',
    reference: 'structure',
    target: 'pdl1',
    rmsd: 1.23,
    alignedLength: 110,
    tmScoreA: 0.9123,
    tmScoreB: 0.9012,
  }
  await client.callTool({
    name: 'mol_align_deliver',
    arguments: {
      sceneId: scene.sceneId,
      commandIndex,
      data: JSON.stringify({ ok: true, result: alignment }),
    },
  })
  const aligned = await alignPromise
  assert.equal(aligned.isError, undefined)
  assert.equal(
    aligned.structuredContent,
    undefined,
    'mol_align must return text; structuredContent would hide the metrics from the model',
  )
  assert.match(aligned.content[0].text, /RMSD 1\.23 A/)
  assert.match(aligned.content[0].text, /TM-score 0\.9123\/0\.9012/)

  const tmPromise = client.callTool({
    name: 'mol_tmscore',
    arguments: {
      reference: { kind: 'chain', chain: 'A', structureId: 'structure' },
      target: { kind: 'chain', chain: 'A', structureId: 'pdl1' },
    },
  })
  for (let attempt = 0; attempt < 4; attempt += 1) {
    poll = await client.callTool({
      name: 'mol_viewer_poll',
      arguments: { sceneId: scene.sceneId, revision: polledScene.revision, timeoutMs: 1000 },
    })
    if (poll.structuredContent?.tmscore !== null) break
  }
  assert.ok(poll?.structuredContent?.tmscore)
  const tmscore = poll.structuredContent.tmscore
  assert.deepEqual(tmscore.request.reference, { kind: 'chain', chain: 'A', structureId: 'structure' })
  await client.callTool({
    name: 'mol_tmscore_deliver',
    arguments: {
      queryId: tmscore.queryId,
      data: JSON.stringify({
        ok: true,
        result: {
          method: 'tm-align',
          reference: 'chain A in structure structure',
          target: 'chain A in structure pdl1',
          rmsd: 2.34,
          tmScoreA: 0.8,
          tmScoreB: 0.7,
          alignedLength: 90,
          referenceAtoms: 100,
          targetAtoms: 95,
        },
      }),
    },
  })
  const scored = await tmPromise
  assert.equal(scored.isError, undefined)
  assert.match(scored.content[0].text, /TM-score 0\.8000\/0\.7000/)
  assert.match(scored.content[0].text, /No structure was moved/)
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
