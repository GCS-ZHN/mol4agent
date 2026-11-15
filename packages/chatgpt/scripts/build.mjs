/**
 * Build the plugin's two artifacts:
 *
 * - lib/viewer.html: one self-contained MCP App (core + Mol* + official UI CSS)
 * - lib/server.js:   stdio MCP server with a shebang, dependencies bundled
 *
 * Both are written through temp files and atomic renames so a running process
 * never reads a half-written file.
 */
import { build } from 'esbuild'
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(root, 'lib')
const BANNER = '/*! @gcszhn/mol4agent-chatgpt | includes Mol* (MIT), https://github.com/molstar/molstar */'

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

async function replace(file, contents, mode) {
  const temporary = `${file}.tmp-${String(process.pid)}`
  await writeFile(temporary, contents)
  if (mode !== undefined) await chmod(temporary, mode)
  await rename(temporary, file)
}

const client = await bundle('src/client/main.ts', {
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  conditions: ['browser'],
  mainFields: ['browser', 'module', 'main'],
  // Core resolves Mol* through its own node_modules link, which may carry a
  // different React copy. Force every React import in the bundle onto this
  // package's single React 18 instance.
  alias: {
    react: join(root, 'node_modules/react'),
    'react-dom': join(root, 'node_modules/react-dom'),
  },
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.css': 'text' },
  minify: true,
  legalComments: 'none',
  banner: { js: BANNER },
})

const template = await readFile(join(root, 'src/client/index.html'), 'utf8')
const inlineScript = Buffer.from(client.toString('utf8').replaceAll('</script', '<\\/script'), 'utf8')
// Use a replacer function: a replacement string would treat `$&`, `$'`, and
// similar sequences in the minified bundle as substitution patterns.
const html = template.replace('/*__MOL4AGENT_JS__*/', () => inlineScript.toString('utf8'))
await replace(join(outDir, 'viewer.html'), html)

const server = await bundle('src/server.ts', {
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  conditions: ['node'],
  mainFields: ['module', 'main'],
  external: ['node:*'],
  banner: { js: '#!/usr/bin/env node\n' + BANNER },
})
await replace(join(outDir, 'server.js'), server, 0o755)

const sizes = await Promise.all(
  ['viewer.html', 'server.js'].map(async file => {
    const info = await stat(join(outDir, file))
    return `${file}: ${(info.size / 1024 / 1024).toFixed(2)} MiB`
  }),
)
console.log(`built @gcszhn/mol4agent-chatgpt\n${sizes.map(line => `  ${line}`).join('\n')}`)
