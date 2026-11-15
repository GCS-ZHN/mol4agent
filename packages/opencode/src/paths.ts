/**
 * File resolution for the OpenCode server part: the only place a path becomes
 * bytes. The format is derived here and passed explicitly to core.
 *
 * @module @gcszhn/mol4agent-opencode/paths
 */
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { MolFormat } from '@gcszhn/mol4agent-core/protocol'
import { EXTENSION_FORMATS, baseNameOf, formatOfFile, isGzipFile } from './formats.ts'

/** One structure file this adapter can hand to the viewer. */
export interface ResolvedMoleculeFile {
  readonly absolutePath: string
  readonly format: MolFormat
  readonly label: string
  readonly bytes: Uint8Array
}

const SUPPORTED = Object.keys(EXTENSION_FORMATS).join(', ')

/**
 * Resolve and read one path, enforcing the adapter's size limit.
 *
 * `cwd` is the workspace directory the server resolved from the session; a
 * relative path is resolved against it.
 */
export async function resolveMoleculeFile(
  cwd: string,
  requestedPath: string,
  maxFileBytes: number,
  signal: AbortSignal,
): Promise<ResolvedMoleculeFile> {
  const requested = requestedPath.trim()
  if (requested === '') throw new Error('path must be a non-empty string')
  const absolutePath = isAbsolute(requested) ? requested : resolve(cwd, requested)
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
  let bytes: Uint8Array = new Uint8Array(await readFile(absolutePath, { signal }))
  if (isGzipFile(absolutePath)) {
    try {
      // `maxOutputLength` caps decompression so a gzip bomb cannot allocate
      // gigabytes before the size check.
      bytes = new Uint8Array(gunzipSync(bytes, { maxOutputLength: maxFileBytes }))
    } catch (reason) {
      throw new Error(`could not decompress ${absolutePath} (limit ${maxFileBytes} bytes): ${reason instanceof Error ? reason.message : String(reason)}`)
    }
  }
  return {
    absolutePath,
    format,
    label: baseNameOf(absolutePath),
    bytes,
  }
}
