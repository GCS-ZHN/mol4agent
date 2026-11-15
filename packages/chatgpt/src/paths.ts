/**
 * File resolution for the MCP server: the only place a model-supplied path
 * becomes bytes. The struct format is derived here and passed explicitly to
 * core; core never sees a path.
 *
 * @module @gcszhn/mol4agent-chatgpt/paths
 */
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { MolFormat } from '@gcszhn/mol4agent-core/protocol'
import { EXTENSION_FORMATS, baseNameOf, formatOfFile } from './formats.ts'

/** One structure file this adapter can hand to the viewer. */
export interface ResolvedMoleculeFile {
  readonly absolutePath: string
  readonly format: MolFormat
  readonly label: string
  readonly bytes: Uint8Array
}

const SUPPORTED = Object.keys(EXTENSION_FORMATS).join(', ')
const ROOT_TTL_MS = 30_000

let cachedRoot: { readonly value: string; readonly at: number } | null = null

/** How the workspace root was chosen, plus the raw signals used. */
export interface WorkspaceInfo {
  readonly root: string
  readonly source: 'env' | 'roots' | 'cwd'
  readonly cwd: string
  readonly roots: readonly string[]
  readonly rootError?: string
}

/** Inspect the workspace signals without using the short-lived cache. */
export async function inspectWorkspace(server: McpServer, signal: AbortSignal): Promise<WorkspaceInfo> {
  const fromEnv = process.env.MOL4AGENT_CWD?.trim()
  const roots: string[] = []
  let rootError: string | undefined
  try {
    const result = await server.server.listRoots(undefined, { signal })
    for (const root of result.roots) {
      if (root.uri.startsWith('file://')) roots.push(fileURLToPath(root.uri))
    }
  } catch (reason) {
    rootError = reason instanceof Error ? reason.message : String(reason)
  }
  if (fromEnv !== undefined && fromEnv !== '') {
    return {
      root: fromEnv,
      source: 'env',
      cwd: process.cwd(),
      roots,
      ...(rootError === undefined ? {} : { rootError }),
    }
  }
  const firstRoot = roots[0]
  if (firstRoot !== undefined) {
    return {
      root: firstRoot,
      source: 'roots',
      cwd: process.cwd(),
      roots,
      ...(rootError === undefined ? {} : { rootError }),
    }
  }
  return {
    root: process.cwd(),
    source: 'cwd',
    cwd: process.cwd(),
    roots,
    ...(rootError === undefined ? {} : { rootError }),
  }
}

/**
 * Resolve the conversation workspace.
 *
 * Codex/Claude expose the workspace as MCP roots. If the host does not provide
 * roots, fall back to `MOL4AGENT_CWD` and then the server process cwd.
 */
export async function workspaceRoot(server: McpServer, signal: AbortSignal): Promise<string> {
  const fromEnv = process.env.MOL4AGENT_CWD?.trim()
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  if (cachedRoot !== null && Date.now() - cachedRoot.at < ROOT_TTL_MS) return cachedRoot.value
  const info = await inspectWorkspace(server, signal)
  cachedRoot = { value: info.root, at: Date.now() }
  return info.root
}

/**
 * Resolve and read one model-supplied path, enforcing the adapter's size limit.
 */
export async function resolveMoleculeFile(
  server: McpServer,
  requestedPath: string,
  maxFileBytes: number,
  signal: AbortSignal,
): Promise<ResolvedMoleculeFile> {
  const requested = requestedPath.trim()
  if (requested === '') throw new Error('path must be a non-empty string')
  const root = await workspaceRoot(server, signal)
  const absolutePath = isAbsolute(requested) ? requested : resolve(root, requested)
  const format = formatOfFile(absolutePath)
  if (format === undefined) {
    throw new Error(`unsupported molecular file type: ${requested}\nsupported suffixes: ${SUPPORTED}`)
  }
  let info
  try {
    info = await stat(absolutePath)
  } catch (reason) {
    throw new Error(`cannot read ${absolutePath}: ${reason instanceof Error ? reason.message : String(reason)}`)
  }
  if (!info.isFile()) throw new Error(`not a regular file: ${absolutePath}`)
  if (info.size > maxFileBytes) {
    throw new Error(`file is too large (${info.size} bytes; limit ${maxFileBytes})`)
  }
  const bytes = new Uint8Array(await readFile(absolutePath, { signal }))
  return {
    absolutePath,
    format,
    label: baseNameOf(absolutePath),
    bytes,
  }
}
