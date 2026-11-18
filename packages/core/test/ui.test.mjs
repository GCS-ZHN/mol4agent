/**
 * Real-browser multi-structure smoke test.
 *
 * Loads two PD-L1 structures into one viewer, styles them separately, runs
 * TM-align on chain B against chain A, exercises structure-scoped selection and
 * visibility, and captures a PNG. Skipped when Chrome is unavailable.
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

test('loads two structures, aligns them, and captures a PNG', { timeout: 150_000 }, async t => {
  if (!(await exists(chrome))) {
    t.skip('Google Chrome is not installed')
    return
  }
  await mkdir(buildDir, { recursive: true })
  await mkdir(artifactDir, { recursive: true })
  const capturePath = join(artifactDir, 'multi-capture.png')
  const pagePath = join(artifactDir, 'multi-page.png')
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
    // Core resolves Mol* through its own node_modules link; force every React
    // import onto one instance so ReactSharedInternals is initialized.
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
  const referencePdb = await readFile(join(repoRoot, 'fixtures/7czd.pdb'))
  const targetPdb = await readFile(join(repoRoot, 'fixtures/4zqk.pdb'))
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:100%;height:100%;background:#fff;overflow:hidden}
  #host{position:absolute;inset:0}
  #status{position:absolute;left:8px;top:8px;z-index:10;font:12px monospace;color:#333}
</style></head><body>
<div id="host"></div><div id="status">loading</div>
<script type="module" src="/ui-entry.js"></script>
</body></html>`

  let result = null
  const server = createServer((request, response) => {
    const url = request.url ?? '/'
    if (request.method === 'POST' && url === '/result') {
      const chunks = []
      request.on('data', chunk => chunks.push(chunk))
      request.on('end', () => {
        result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{"ok":true}')
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
      response.end(referencePdb)
      return
    }
    if (url === '/4zqk.pdb') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(targetPdb)
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

  assert.ok(result !== null, `the page never reported a result\n--- log ---\n${interesting.slice(-6000)}`)
  assert.equal(result.error, undefined, result.error)
  assert.deepEqual(result.list.map(structure => structure.id), ['reference', 'target'])
  assert.ok(result.reference.atomCount > 0)
  assert.ok(result.added.summary.atomCount > 0)
  assert.equal(result.styleReference.ok, true, JSON.stringify(result.styleReference))
  assert.equal(result.styleTarget.ok, true, JSON.stringify(result.styleTarget))
  assert.equal(result.align.ok, true, JSON.stringify(result.align))
  assert.ok(result.align.data.alignedLength > 50, `only ${String(result.align.data.alignedLength)} aligned residues`)
  assert.ok(result.align.data.tmScoreA > 0.5, `TM-score ${String(result.align.data.tmScoreA)}`)
  assert.ok(result.align.data.rmsd >= 0)
  assert.equal(result.sequence.ok, true, JSON.stringify(result.sequence))
  assert.ok(result.sequence.data.alignedLength > 50)
  assert.ok(result.sequence.data.rmsd >= 0)
  assert.ok(result.tmscoreBefore.alignedLength > 50, JSON.stringify(result.tmscoreBefore))
  assert.ok(result.tmscoreBefore.tmScoreA > 0.5, JSON.stringify(result.tmscoreBefore))
  assert.equal(result.tmscore.method, 'tm-align')
  assert.ok(result.tmscore.alignedLength > 50, JSON.stringify(result.tmscore))
  assert.ok(result.tmscore.tmScoreA > 0.5, JSON.stringify(result.tmscore))
  assert.ok(result.tmscore.rmsd >= 0, JSON.stringify(result.tmscore))
  assert.equal(result.inspected.target, 'chain A [target]')
  assert.ok(result.inspected.residues <= 200, JSON.stringify(result.inspected))
  assert.ok(result.inspected.residues > 0, JSON.stringify(result.inspected))
  assert.equal(result.select.ok, true, JSON.stringify(result.select))
  assert.equal(result.hidden.ok, true, JSON.stringify(result.hidden))
  assert.equal(result.shown.ok, true, JSON.stringify(result.shown))
  assert.equal(result.focus.ok, true, JSON.stringify(result.focus))
  assert.equal(result.diagnostics.structures, 2)
  assert.deepEqual(result.afterRemove.map(structure => structure.id), ['reference'])
  assert.equal(result.afterRemoveDiagnostics.structures, 1)
  assert.equal(result.removed.ok, true, JSON.stringify(result.removed))

  const png = Buffer.from(result.png, 'base64')
  await writeFile(capturePath, png)
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.ok(png.byteLength > 20_000, `capture is suspiciously small: ${String(png.byteLength)} bytes`)
  assert.ok(await exists(pagePath), 'chrome did not write the page screenshot')
})
