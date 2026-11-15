/**
 * Real-browser smoke test: MCP Apps host -> viewer iframe -> Mol* -> capture.
 *
 * Skipped when Chrome is unavailable. The test uses SwiftShader so it works on
 * headless macOS without a GPU.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'

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

test('viewer renders and delivers a PNG in a real MCP Apps host', { timeout: 120_000 }, async t => {
  if (!(await exists(chrome))) {
    t.skip('Google Chrome is not installed')
    return
  }
  await mkdir(buildDir, { recursive: true })
  await mkdir(artifactDir, { recursive: true })
  const capturePath = join(artifactDir, 'atp-capture.png')
  const pagePath = join(artifactDir, 'atp-page.png')
  await rm(capturePath, { force: true })
  await rm(pagePath, { force: true })

  await build({
    entryPoints: [join(packageRoot, 'test/host/host.ts')],
    outfile: join(buildDir, 'host.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    conditions: ['browser'],
    mainFields: ['browser', 'module', 'main'],
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'warning',
  })

  const hostHtml = await readFile(join(packageRoot, 'test/host/host.html'))
  const viewerHtml = await readFile(join(packageRoot, 'lib/viewer.html'))
  const hostJs = await readFile(join(buildDir, 'host.js'))
  const pdb = await readFile(join(repoRoot, 'fixtures/1atp.pdb'))

  let captured = null
  const server = createServer((request, response) => {
    const url = request.url ?? '/'
    console.log('[test-server]', request.method, url)
    if (request.method === 'POST' && url === '/capture') {
      const chunks = []
      request.on('data', chunk => chunks.push(chunk))
      request.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          const png = Buffer.from(body.data, 'base64')
          captured = { png, width: body.width, height: body.height }
          void writeFile(capturePath, png).then(() => {
            response.writeHead(200, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ bytes: png.byteLength, width: body.width, height: body.height }))
          })
        } catch (reason) {
          response.writeHead(400, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ message: String(reason) }))
        }
      })
      return
    }
    if (url === '/' || url === '/host.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(hostHtml)
      return
    }
    if (url === '/host.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      response.end(hostJs)
      return
    }
    if (url === '/viewer.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(viewerHtml)
      return
    }
    if (url === '/fixture.pdb') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(pdb)
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
    '--virtual-time-budget=60000',
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
    }, 90_000)
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
  assert.ok(captured !== null, `the app never delivered a capture\n--- log ---\n${interesting.slice(-6000)}`)
  assert.ok(captured.png.byteLength > 5_000, `capture is suspiciously small: ${String(captured.png.byteLength)} bytes`)
  assert.equal(captured.width, 800)
  assert.equal(captured.height, 600)
  assert.deepEqual([...captured.png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.ok(await exists(pagePath), 'chrome did not write the host page screenshot')
  assert.ok((await stat(pagePath)).size > 10_000, 'host page screenshot is suspiciously small')
})
