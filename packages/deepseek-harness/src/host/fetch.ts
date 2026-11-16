/**
 * Database downloads for `mol_fetch`.
 *
 * The Host owns the network and the filesystem; core only resolves an entry id
 * to a URL plan. Every download is HTTPS-only, size-capped, time-limited, and
 * written through a temporary file, so a failed fetch never leaves a partial
 * structure at the target path.
 *
 * @module @gcszhn/mol4agent-deepseekharness/host/fetch
 */
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { readSourceIndexField, type ResolvedSource } from '@gcszhn/mol4agent-core/sources'
import { baseNameOf, formatOfFile, isGzipFile } from '../formats.ts'

/** A source that was downloaded and saved. */
export interface DownloadedSource {
  readonly absolutePath: string
  readonly bytes: Uint8Array
  /** Final file URL, after index resolution and redirects. */
  readonly url: string
}

export interface DownloadSourceOptions {
  readonly source: ResolvedSource
  /** Already resolved against the session working directory. */
  readonly targetPath: string
  readonly maxBytes: number
  readonly signal: AbortSignal
  readonly timeoutMs?: number
  /** Test seam; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch
}

/** Invalid `target_path`; the tool turns this into a model-facing argument error. */
export class FetchTargetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FetchTargetError'
  }
}

/** A network or write failure while fetching. */
export class SourceFetchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SourceFetchError'
  }
}

const USER_AGENT = 'mol4agent-dsh/0.2.0 (+https://github.com/GCS-ZHN/mol4agent)'
const DEFAULT_TIMEOUT_MS = 30_000
const INDEX_MAX_BYTES = 2 * 1024 * 1024

/**
 * Resolve `target_path` to a concrete file path.
 *
 * - A trailing separator, or an existing directory, appends the source's
 *   suggested file name.
 * - A basename without any suffix gets the source's suffix.
 * - Any other unsupported or mismatched suffix is rejected, because `mol_open`
 *   would otherwise parse the bytes as a different format.
 */
export async function resolveFetchTarget(
  cwd: string,
  requestedPath: string,
  source: ResolvedSource,
): Promise<string> {
  const requested = requestedPath.trim()
  if (requested === '') throw new FetchTargetError('target_path must be a non-empty path')
  const absolute = isAbsolute(requested) ? requested : resolve(cwd, requested)
  if (requested.endsWith('/') || requested.endsWith('\\') || await isDirectory(absolute)) {
    return join(absolute, source.fileName)
  }

  const name = baseNameOf(absolute)
  const suffix = source.fileName.slice(source.fileName.lastIndexOf('.'))
  if (isGzipFile(absolute)) {
    throw new FetchTargetError(
      `target_path must not end in .gz: sources are saved uncompressed (${suffix})`,
    )
  }
  const format = formatOfFile(absolute)
  if (format === undefined) {
    if (!name.includes('.')) return `${absolute}${suffix}`
    throw new FetchTargetError(
      `unsupported target suffix for ${name}; ${source.sourceDb} produces ${suffix} content. `
      + `Use a ${suffix} path or a directory.`,
    )
  }
  if (format !== source.format) {
    throw new FetchTargetError(
      `${source.sourceDb} produces ${source.format} content, but ${name} maps to ${format}. `
      + `Use a ${suffix} path or a directory.`,
    )
  }
  return absolute
}

/** Fetch one resolved source and save it atomically at `targetPath`. */
export async function downloadMoleculeSource(options: DownloadSourceOptions): Promise<DownloadedSource> {
  const fetchImpl = options.fetchImpl ?? fetch
  const signal = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  ])
  try {
    const url = await resolveDownloadUrl(fetchImpl, options.source, signal)
    const response = await fetchImpl(url, {
      signal,
      redirect: 'follow',
      headers: { 'user-agent': USER_AGENT, accept: 'application/octet-stream, text/plain, */*' },
    })
    if (!response.ok) {
      throw new SourceFetchError(
        `${options.source.sourceDb} download failed with HTTP ${response.status} ${response.statusText}`.trim(),
      )
    }
    const finalUrl = assertHttpsUrl(response.url || url)
    const bytes = await readCapped(response, options.maxBytes)
    if (bytes.byteLength === 0) {
      throw new SourceFetchError(`${options.source.sourceDb} returned an empty file for ${options.source.entryId}`)
    }
    await writeAtomically(options.targetPath, bytes)
    return { absolutePath: options.targetPath, bytes, url: finalUrl }
  } catch (error) {
    if (options.signal.aborted) throw error
    if (error instanceof SourceFetchError) throw error
    const reason = error instanceof Error ? error.message : String(error)
    throw new SourceFetchError(`could not download ${options.source.description}: ${reason}`)
  }
}

async function resolveDownloadUrl(
  fetchImpl: typeof fetch,
  source: ResolvedSource,
  signal: AbortSignal,
): Promise<string> {
  const indexField = source.plan.indexField
  if (indexField === undefined) return assertHttpsUrl(source.plan.url)

  const response = await fetchImpl(source.plan.url, {
    signal,
    redirect: 'follow',
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
  })
  if (!response.ok) {
    throw new SourceFetchError(
      `${source.sourceDb} index request failed with HTTP ${response.status} ${response.statusText}`.trim(),
    )
  }
  assertHttpsUrl(response.url || source.plan.url)
  const text = new TextDecoder('utf-8', { fatal: false }).decode(await readCapped(response, INDEX_MAX_BYTES))
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    throw new SourceFetchError(`${source.sourceDb} returned an invalid JSON index`)
  }
  const url = readSourceIndexField(payload, indexField)
  if (url === undefined) {
    throw new SourceFetchError(
      `${source.sourceDb} index has no ${indexField}; the entry may not exist or may be unreleased`,
    )
  }
  return assertHttpsUrl(url)
}

function assertHttpsUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new SourceFetchError(`source returned an invalid download URL: ${value}`)
  }
  if (url.protocol !== 'https:') {
    throw new SourceFetchError(`refusing a non-HTTPS download URL: ${value}`)
  }
  return url.toString()
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new SourceFetchError(`download is too large (${declared} bytes; limit ${maxBytes})`)
  }
  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maxBytes) {
      throw new SourceFetchError(`download is too large (${bytes.byteLength} bytes; limit ${maxBytes})`)
    }
    return bytes
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new SourceFetchError(`download is too large (over ${maxBytes} bytes)`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function writeAtomically(targetPath: string, bytes: Uint8Array): Promise<void> {
  const directory = dirname(targetPath)
  await mkdir(directory, { recursive: true })
  const temporary = join(
    directory,
    `.${basename(targetPath)}.mol4agent-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`,
  )
  try {
    await writeFile(temporary, bytes, { flag: 'wx' })
    await rename(temporary, targetPath)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}
