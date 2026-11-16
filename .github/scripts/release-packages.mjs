#!/usr/bin/env node
// Publish only the packages whose package.json version is not released yet.
//
// Runs after `ci` succeeds on `main` (or manually with DRY_RUN). npm packages
// are checked against the registry; the ChatGPT plugin is checked against the
// generated `plugin-dist` branch. A merge that does not bump a package version
// is a no-op for that package.
import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const dryRun = process.env.DRY_RUN === '1'
const repo = process.env.GITHUB_REPOSITORY || 'GCS-ZHN/mol4agent'
const token = process.env.GITHUB_TOKEN || ''

const npmPackages = [
  { dir: 'packages/core', name: '@gcszhn/mol4agent-core' },
  { dir: 'packages/deepseek-harness', name: '@gcszhn/mol4agent-deepseekharness' },
  { dir: 'packages/opencode', name: '@gcszhn/mol4agent-opencode' },
]

const chatgpt = {
  dir: 'packages/chatgpt',
  name: '@gcszhn/mol4agent-chatgpt',
  target: 'plugin-dist',
}

const entries = ['lib', 'skills', '.codex-plugin', '.mcp.json', 'icon.svg', 'README.md', 'README_zh.md']

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), 'utf8'))
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
    ...opts,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args[0] ?? ''} exited with status ${result.status}`)
  }
}

function capture(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    ...opts,
  })
}

function npmHasVersion(name, version) {
  const result = capture('npm', ['view', `${name}@${version}`, 'version', '--json'])
  if (result.status === 0) return true
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  if (/\bE404\b|404 Not Found/i.test(output)) return false
  throw new Error(`cannot query npm for ${name}@${version}:\n${output.trim()}`)
}

function pluginDistVersion() {
  const url = `https://raw.githubusercontent.com/${repo}/plugin-dist/plugins/mol4agent/.codex-plugin/plugin.json?cache=${Date.now()}`
  const headers = token ? ['-H', `Authorization: Bearer ${token}`] : []
  const result = capture('curl', [
    '-sS',
    '-L',
    '--max-time',
    '30',
    ...headers,
    '-w',
    '\n%{http_code}',
    url,
  ])
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`cannot read ${repo}/plugin-dist:\n${result.stderr || ''}`.trim())
  }
  const split = result.stdout.lastIndexOf('\n')
  const status = Number(result.stdout.slice(split + 1))
  const body = result.stdout.slice(0, split)
  if (status === 404) return null
  if (status !== 200) throw new Error(`${repo}/plugin-dist returned HTTP ${status}`)
  return JSON.parse(body).version
}

function publishNpm(item) {
  console.log(`[release] publishing ${item.name}@${item.version} to npm`)
  run('pnpm', ['publish', '--access', 'public', '--no-git-checks'], {
    cwd: join(root, item.dir),
  })
}

function publishPluginDist(item) {
  console.log(`[release] publishing ${item.name}@${item.version} to plugin-dist`)
  run('pnpm', ['--filter', item.name, 'build'])

  const tmp = mkdtempSync(join(tmpdir(), 'mol4agent-plugin-dist-'))
  try {
    const destination = join(tmp, 'plugins', 'mol4agent')
    mkdirSync(destination, { recursive: true })
    for (const entry of entries) {
      cpSync(join(root, 'packages/chatgpt', entry), join(destination, entry), {
        recursive: true,
      })
    }

    run('git', ['init', '-b', 'plugin-dist'], { cwd: tmp })
    run('git', ['config', 'user.name', 'github-actions[bot]'], { cwd: tmp })
    run('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'], {
      cwd: tmp,
    })
    run('git', ['add', '-A'], { cwd: tmp })
    run('git', ['commit', '-m', `plugin-dist: chatgpt v${item.version}`], { cwd: tmp })

    if (!token) throw new Error('GITHUB_TOKEN is required to update plugin-dist')
    // Keep the credential out of argv so a failed push cannot print it.
    const auth = Buffer.from(`x-access-token:${token}`).toString('base64')
    run('git', ['push', '--force', `https://github.com/${repo}.git`, 'plugin-dist'], {
      cwd: tmp,
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${auth}`,
      },
    })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

function planPackage(item, target, releasedVersion) {
  const release = releasedVersion !== item.version
  return {
    ...item,
    target,
    version: item.version,
    action: release ? (dryRun ? 'would publish' : 'publish') : 'skip',
    reason: release ? `not released on ${target}` : `already released on ${target}`,
  }
}

function buildPlan() {
  const plan = []
  for (const item of npmPackages) {
    const pkg = readJson(`${item.dir}/package.json`)
    plan.push(
      planPackage(
        { ...item, version: pkg.version },
        'npm',
        npmHasVersion(item.name, pkg.version) ? pkg.version : null,
      ),
    )
  }

  const pkg = readJson(`${chatgpt.dir}/package.json`)
  const plugin = readJson(`${chatgpt.dir}/.codex-plugin/plugin.json`)
  if (plugin.version !== pkg.version) {
    throw new Error(
      `chatgpt versions differ: package.json ${pkg.version} vs plugin.json ${plugin.version}`,
    )
  }
  plan.push(planPackage({ ...chatgpt, version: pkg.version }, 'plugin-dist', pluginDistVersion()))
  return plan
}

function printPlan(plan) {
  for (const item of plan) {
    console.log(`[release] ${item.name}@${item.version}: ${item.action} (${item.reason})`)
  }

  const rows = plan
    .map((item) => `| \`${item.name}\` | \`${item.version}\` | ${item.target} | ${item.action} |`)
    .join('\n')
  const summary = `## Release plan\n\n| Package | Version | Target | Result |\n|---|---|---|---|\n${rows}\n`
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
}

function main() {
  const plan = buildPlan()
  printPlan(plan)

  if (dryRun) {
    console.log('[release] dry run: nothing was published')
    return
  }

  const toPublish = plan.filter((item) => item.action === 'publish')
  if (toPublish.length === 0) {
    console.log('[release] all package versions are already released')
    return
  }

  // Adapters' builds and published manifests read core from lib/.
  run('pnpm', ['--filter', '@gcszhn/mol4agent-core', 'build'])

  for (const item of toPublish) {
    if (item.target === 'npm') publishNpm(item)
    else publishPluginDist(item)
  }

  console.log(`[release] published ${toPublish.map((item) => `${item.name}@${item.version}`).join(', ')}`)
}

try {
  main()
} catch (error) {
  console.error(`[release] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
