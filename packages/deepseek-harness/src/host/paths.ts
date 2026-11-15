/**
 * DSH file resolution: the only place a workspace path becomes bytes.
 *
 * @module @gcszhn/mol4agent-deepseekharness/host/paths
 */
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolArgsError } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { MolFormat } from '@gcszhn/mol4agent-core/protocol'
import { EXTENSION_FORMATS, baseNameOf, formatOfFile } from '../formats.ts'

/** One file this adapter can hand to the viewer. */
export interface ResolvedMoleculeFile {
  readonly absolutePath: string
  readonly format: MolFormat
  readonly label: string
  readonly bytes: Uint8Array
}

const SUPPORTED = Object.keys(EXTENSION_FORMATS).join(', ')

/**
 * Resolve and read one agent-supplied path under the Session's working
 * directory, enforcing the adapter's size limit.
 */
export async function resolveMoleculeFile(
  ctx: Context,
  agent: Agent,
  requestedPath: string,
  maxFileBytes: number,
  signal: AbortSignal,
): Promise<ResolvedMoleculeFile> {
  const requested = requestedPath.trim()
  if (requested === '') throw new ToolArgsError(['path must be a non-empty string'])
  const cwd = await ctx.workingDirectory.ensure(agent, signal)
  const absolutePath = isAbsolute(requested) ? requested : resolve(cwd, requested)
  const format = formatOfFile(absolutePath)
  if (format === undefined) {
    throw new ToolArgsError([
      `unsupported molecular file type: ${requested}`,
      `supported suffixes: ${SUPPORTED}`,
    ])
  }
  let info
  try {
    info = await stat(absolutePath)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new ToolArgsError([`cannot read ${absolutePath}: ${reason}`])
  }
  if (!info.isFile()) throw new ToolArgsError([`not a regular file: ${absolutePath}`])
  if (info.size > maxFileBytes) {
    throw new ToolArgsError([
      `file is too large to preview (${info.size} bytes; limit ${maxFileBytes})`,
      'use a smaller file or raise the adapter limit',
    ])
  }
  const bytes = await readFile(absolutePath, { signal })
  return {
    absolutePath,
    format,
    label: baseNameOf(absolutePath),
    bytes: new Uint8Array(bytes),
  }
}
