/**
 * Build the OpenCode plugin's artifacts:
 *
 * - dist/index.js — server part (ESM, core bundled, `@opencode/*`/`node:*` external)
 * - dist/gui.cjs  — GUI part (single CommonJS file; core + Mol* + React bundled,
 *                   Solid/effect/@opencode/electron/node external, CSS as text)
 * - dist/rpc.js   — the typed RPC contract for external consumers
 *
 * The GUI is built with esbuild, not Vite: Vite's `inlineDynamicImports` inlines
 * the lazy `import("@gcszhn/mol4agent-core")` eagerly, and Mol*'s Markdown
 * dependency runs `document.createElement` at module scope, crashing the
 * Electron main process. esbuild keeps the dynamic import lazy. Since Solid 1.9
 * has no standalone JSX runtime, the GUI source uses `createComponent` and
 * imperative DOM instead of JSX.
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

const gui = await build({
  entryPoints: [join(root, 'src/gui/gui.tsx')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  conditions: ['browser'],
  mainFields: ['browser', 'module', 'main'],
  alias: {
    react: join(root, 'node_modules/react'),
    'react-dom': join(root, 'node_modules/react-dom'),
  },
  loader: { '.css': 'text' },
  define: { 'process.env.NODE_ENV': '"production"' },
  external: ['@opencode/*', 'solid-js', 'solid-js/web', 'solid-js/store', 'effect', 'effect/*', 'electron', 'node:*'],
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
  banner: { js: BANNER },
})
await writeAtomic(join(outDir, 'gui.cjs'), gui.outputFiles[0].contents)

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

console.log(`built @gcszhn/mol4agent-opencode
  index.js: ${(server.outputFiles[0].contents.length / 1024).toFixed(1)} KiB
  gui.cjs:  ${(gui.outputFiles[0].contents.length / 1024 / 1024).toFixed(2)} MiB
  rpc.js:   ${(rpc.outputFiles[0].contents.length / 1024).toFixed(1)} KiB`)
