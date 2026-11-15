/**
 * Build the plugin's server and RPC artifacts. The GUI bundle
 * (`dist/gui.cjs`) is built by Vite through `vite.config.ts`; the package
 * `build` script runs both.
 *
 * - dist/index.js — server part (ESM, core bundled, `@opencode/*`/`node:*` external)
 * - dist/rpc.js   — the typed RPC contract for external consumers
 *
 * Written through temp files + atomic renames so a live reload never reads a
 * half-written bundle.
 */
import { build } from 'esbuild'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(root, 'dist')
const BANNER = '/*! @gcszhn/mol4agent-opencode | includes Mol* (MIT), https://github.com/molstar/molstar */'

await mkdir(outDir, { recursive: true })

async function writeAtomic(file, contents) {
  const temporary = `${file}.tmp-${String(process.pid)}`
  await writeFile(temporary, contents)
  await rename(temporary, file)
}

const server = await build({
  entryPoints: [join(root, 'src/server.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  conditions: ['node'],
  mainFields: ['module', 'main'],
  external: ['@opencode/*', 'node:*'],
  logLevel: 'warning',
  banner: { js: BANNER },
})
await writeAtomic(join(outDir, 'index.js'), server.outputFiles[0].contents)

const rpc = await build({
  entryPoints: [join(root, 'src/rpc.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
  external: ['@opencode/*'],
  logLevel: 'warning',
})
await writeAtomic(join(outDir, 'rpc.js'), rpc.outputFiles[0].contents)

console.log(`built @gcszhn/mol4agent-opencode (server)
  index.js: ${(server.outputFiles[0].contents.length / 1024).toFixed(1)} KiB
  rpc.js:   ${(rpc.outputFiles[0].contents.length / 1024).toFixed(1)} KiB`)
