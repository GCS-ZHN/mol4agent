/**
 * Real-browser smoke test for the DSH document body.
 *
 * Mounts `MolBody` with fake DSH hooks and a two-structure projection. The
 * page loads the primary file, adds the target through `structures[]`, applies
 * a targeted style and TM-align, and delivers a real capture. Skipped when
 * Chrome is unavailable.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'
import { decodeInspectPayload } from '../src/host/inspect-payload.ts'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const repoRoot = resolve(packageRoot, '../..')
const buildDir = join(packageRoot, 'test', '.build')
const artifactDir = join(packageRoot, 'test', 'artifacts')
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

test('renders two structures, aligns them, and reports a capture', { timeout: 150_000 }, async t => {
  if (!(await exists(chrome))) {
    t.skip('Google Chrome is not installed')
    return
  }
  await mkdir(buildDir, { recursive: true })
  await mkdir(artifactDir, { recursive: true })
  const capturePath = join(artifactDir, 'dsh-capture.png')
  const pagePath = join(artifactDir, 'dsh-page.png')
  await rm(capturePath, { force: true })
  await rm(pagePath, { force: true })

  await build({
    entryPoints: [join(packageRoot, 'test/ui-entry.ts')],
    outfile: join(buildDir, 'ui-entry.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2022'],
    conditions: ['browser'],
    mainFields: ['browser', 'module', 'main'],
    alias: {
      react: join(packageRoot, 'node_modules/react'),
      'react-dom': join(packageRoot, 'node_modules/react-dom'),
    },
    loader: { '.css': 'text' },
    define: { 'process.env.NODE_ENV': '"production"' },
    minify: true,
    logLevel: 'warning',
  })

  const bundle = await readFile(join(buildDir, 'ui-entry.js'))
  const primary = await readFile(join(repoRoot, 'fixtures/7czd.pdb'))
  const target = await readFile(join(repoRoot, 'fixtures/4zqk.pdb'))
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:100%;height:100%;background:#fff;overflow:hidden}
  #host{position:absolute;inset:0}
</style></head><body><div id="host"></div>
<script type="module" src="/ui-entry.js"></script>
</body></html>`

  let captured = null
  let alignResult = null
  let tmScoreResult = null
  let inspectResult = null
  const server = createServer((request, response) => {
    const url = request.url ?? '/'
    if (request.method === 'POST' && url === '/align-result') {
      const chunks = []
      request.on('data', chunk => chunks.push(chunk))
      request.on('end', () => {
        alignResult = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{}')
      })
      return
    }
    if (request.method === 'POST' && url === '/inspect') {
      const chunks = []
      request.on('data', chunk => chunks.push(chunk))
      request.on('end', () => {
        inspectResult = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        inspectResult.answer = inspectResult.encoded === undefined ? inspectResult.answer : decodeInspectPayload(inspectResult.encoded)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{}')
      })
      return
    }
    if (request.method === 'POST' && url === '/tm-score') {
      const chunks = []
      request.on('data', chunk => chunks.push(chunk))
      request.on('end', () => {
        tmScoreResult = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{}')
      })
      return
    }
    if (request.method === 'POST' && url === '/capture') {
      const chunks = []
      request.on('data', chunk => chunks.push(chunk))
      request.on('end', () => {
        try {
          captured = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end('{"ok":true}')
        } catch (reason) {
          response.writeHead(400, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ message: String(reason) }))
        }
      })
      return
    }
    if (url === '/' || url === '/index.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(html)
      return
    }
    if (url === '/ui-entry.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      response.end(bundle)
      return
    }
    if (url === '/7czd.pdb') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(primary)
      return
    }
    if (url === '/4zqk.pdb') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(target)
      return
    }
    response.writeHead(404)
    response.end('not found')
  })

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  t.after(() => { server.close() })
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  const url = `http://127.0.0.1:${String(address.port)}/`

  const profile = join(buildDir, 'chrome-profile')
  await rm(profile, { recursive: true, force: true })
  let logs = ''
  const child = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--run-all-compositor-stages-before-draw',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1100,900',
    '--virtual-time-budget=90000',
    `--user-data-dir=${profile}`,
    '--enable-logging=stderr',
    `--screenshot=${pagePath}`,
    url,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', chunk => { logs += chunk.toString() })
  child.stderr.on('data', chunk => { logs += chunk.toString() })

  const exitCode = await new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectExit(new Error(`chrome timed out\n${logs.slice(-4000)}`))
    }, 120_000)
    child.once('error', error => {
      clearTimeout(timer)
      rejectExit(error)
    })
    child.once('exit', code => {
      clearTimeout(timer)
      resolveExit(code)
    })
  })
  assert.equal(exitCode, 0, `chrome exited with ${String(exitCode)}\n${logs.slice(-4000)}`)
  const interesting = logs
    .split('\n')
    .filter(line => !line.includes('Parsed message') && !line.includes('Sending message'))
    .join('\n')
  await writeFile(join(artifactDir, 'chrome.log'), interesting)

  assert.ok(captured !== null, `the body never delivered a capture\n--- log ---\n${interesting.slice(-6000)}`)
  assert.equal(captured.callId, 'capture-test')
  const report = captured.report
  assert.equal(report.status, 'ready')
  assert.equal(report.structures, 2, JSON.stringify(report))
  assert.ok(report.applied >= 4, JSON.stringify(report))
  assert.equal(report.visibleContent, true, JSON.stringify(report))
  assert.equal(report.applyErrors, undefined, JSON.stringify(report.applyErrors))
  assert.ok(alignResult !== null, 'the body never delivered alignment metrics')
  assert.equal(alignResult.callId, 'align-test')
  assert.equal(alignResult.payload.ok, true, JSON.stringify(alignResult.payload))
  assert.equal(typeof alignResult.payload.data.rmsd, 'number', JSON.stringify(alignResult.payload))
  assert.ok(alignResult.payload.data.alignedLength > 50, JSON.stringify(alignResult.payload))
  assert.ok(tmScoreResult !== null, 'the body never delivered TM-score metrics')
  assert.equal(tmScoreResult.callId, 'tm-test')
  assert.equal(tmScoreResult.answer.ok, true, JSON.stringify(tmScoreResult.answer))
  assert.equal(typeof tmScoreResult.answer.result.rmsd, 'number', JSON.stringify(tmScoreResult.answer))
  assert.ok(tmScoreResult.answer.result.alignedLength > 50, JSON.stringify(tmScoreResult.answer))
  assert.ok(inspectResult !== null, 'the body never delivered an inspection')
  assert.equal(inspectResult.answer.ok, true, JSON.stringify(inspectResult.answer))
  assert.equal(inspectResult.answer.result.target, 'chain B [structure]')
  assert.ok(inspectResult.answer.result.residues > 100, JSON.stringify(inspectResult.answer))

  const png = Buffer.from(captured.png, 'base64')
  await writeFile(capturePath, png)
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.ok(png.byteLength > 20_000, `capture is suspiciously small: ${String(png.byteLength)} bytes`)
  assert.ok(await exists(pagePath), 'chrome did not write the page screenshot')
})
