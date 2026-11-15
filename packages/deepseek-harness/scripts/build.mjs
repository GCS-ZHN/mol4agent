/**
 * Build the DSH host and browser artifacts.
 *
 * Host: plain ESM; `@deepseek-ai/*` stays external and resolves from the DSH
 * installation (same peer-dependency pattern as other profile plugins).
 *
 * Browser: DSH's lazy-CJS module format. The client is one
 * `window.__ModuleLoader__.load({ id, factory })` registration containing core,
 * Mol*, and the official UI CSS; no separate chunk.
 */
import { build } from 'esbuild'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const id = pkg.name
const outDir = join(root, 'lib')

const CLIENT_EXTERNALS = ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime']
const BANNER = '/*! @gcszhn/mol4agent-deepseekharness | includes Mol* (MIT), https://github.com/molstar/molstar */'

await mkdir(outDir, { recursive: true })

async function bundle(entry, options) {
  const result = await build({
    entryPoints: [join(root, entry)],
    bundle: true,
    write: false,
    logLevel: 'warning',
    ...options,
  })
  return Buffer.concat(result.outputFiles.map(file => file.contents))
}

function wrapClient(contents) {
  return Buffer.concat([
    Buffer.from(
      `window.__ModuleLoader__.load({id:${JSON.stringify(id)},factory:require=>{var module={exports:{}};var exports=module.exports;`,
      'utf8',
    ),
    contents,
    Buffer.from('\nreturn module.exports}});\n', 'utf8'),
  ])
}

async function replace(file, contents) {
  const temporary = `${file}.tmp-${String(process.pid)}`
  await writeFile(temporary, contents)
  await rename(temporary, file)
}

// Host: ESM, no browser globals, DSH packages provided by the installation.
const host = await bundle('src/host/index.ts', {
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external: ['@deepseek-ai/*', 'node:*'],
  banner: { js: BANNER },
})

// Client: the whole viewer (core + Mol* + official UI + theme CSS). A separate
// lazy chunk proved unreliable through the Desktop dsh-app:// protocol.
const client = await bundle('src/client/index.tsx', {
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: CLIENT_EXTERNALS,
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.css': 'text' },
  minify: true,
  banner: { js: BANNER },
})

// Write the client first: it is the entry whose revision addresses the graph.
await replace(join(outDir, 'client.js'), wrapClient(client))
await replace(join(outDir, 'host.js'), host)

// Remove a chunk left by an earlier build; the current client has no chunk.
await rm(join(outDir, 'client.molstar.js'), { force: true })

const sizes = await Promise.all(
  ['host.js', 'client.js'].map(async file => {
    const info = await stat(join(outDir, file))
    return `${file}: ${(info.size / 1024 / 1024).toFixed(2)} MiB`
  }),
)
console.log(`built ${id}\n${sizes.map(line => `  ${line}`).join('\n')}`)
