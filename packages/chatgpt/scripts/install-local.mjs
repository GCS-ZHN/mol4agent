/**
 * Install the built plugin into a stable local Codex marketplace.
 *
 * The repository `.mcp.json` stays portable. The installed copy gets absolute
 * paths because Codex materializes plugins under a versioned cache directory
 * whose location is not known when the package is built.
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const marketplaceRoot = resolve(
  process.env.MOL4AGENT_MARKETPLACE_ROOT?.trim()
    || join(homedir(), '.codex', 'mol4agent-marketplace'),
)
const pluginRoot = join(marketplaceRoot, 'plugins', 'mol4agent')
const marketplaceFile = join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json')

for (const file of ['lib/server.js', 'lib/viewer.html', '.codex-plugin/plugin.json', '.mcp.json']) {
  try {
    await readFile(join(packageRoot, file))
  } catch {
    console.error(
      `Missing ${file}. Build first:\n`
      + '  pnpm --filter @gcszhn/mol4agent-core build\n'
      + '  pnpm --filter @gcszhn/mol4agent-chatgpt build',
    )
    process.exit(1)
  }
}

await mkdir(join(marketplaceRoot, '.agents', 'plugins'), { recursive: true })
await writeFile(marketplaceFile, `${JSON.stringify({
  name: 'mol4agent-local',
  plugins: [
    {
      name: 'mol4agent',
      source: { source: 'local', path: './plugins/mol4agent' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_USE' },
      category: 'Science',
    },
  ],
}, null, 2)}\n`)

await rm(pluginRoot, { recursive: true, force: true })
await mkdir(pluginRoot, { recursive: true })
for (const entry of ['lib', 'skills', '.codex-plugin', 'icon.svg', 'README.md', 'README_zh.md']) {
  await cp(join(packageRoot, entry), join(pluginRoot, entry), { recursive: true })
}

const mcp = {
  mcpServers: {
    mol4agent: {
      command: 'node',
      args: [join(pluginRoot, 'lib', 'server.js')],
      startup_timeout_sec: 20,
      tool_timeout_sec: 120,
    },
  },
}
await writeFile(join(pluginRoot, '.mcp.json'), `${JSON.stringify(mcp, null, 2)}\n`)

console.log(`Installed mol4agent into ${pluginRoot}`)
console.log('Register it with:')
console.log(`  codex plugin marketplace add ${marketplaceRoot}`)
console.log('  codex plugin add mol4agent@mol4agent-local')
