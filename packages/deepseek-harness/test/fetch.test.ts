import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { resolveSource } from '@gcszhn/mol4agent-core/sources'
import {
  FetchTargetError,
  SourceFetchError,
  downloadMoleculeSource,
  resolveFetchTarget,
} from '../src/host/fetch.ts'

// A real absolute cwd on the running platform, so `resolve`/`join` produce the
// same native spelling the Host returns on POSIX and Windows.
const CWD = resolve('/workspace/project')
const inCwd = (...segments: string[]): string => join(CWD, ...segments)

async function withTempDir<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'mol4agent-fetch-'))
  try {
    return await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function abortSignal(): AbortSignal {
  return new AbortController().signal
}

function textFetch(body: string): typeof fetch {
  return async () => new Response(body, { status: 200 })
}

test('resolves target paths, directory targets, and missing suffixes', async () => {
  const pdb = resolveSource({ entryId: '1crn' })
  assert.equal(await resolveFetchTarget(CWD, 'models/1crn.pdb', pdb), inCwd('models', '1crn.pdb'))
  assert.equal(await resolveFetchTarget(CWD, 'models/1crn', pdb), inCwd('models', '1crn.pdb'))
  assert.equal(await resolveFetchTarget(CWD, 'models/', pdb), inCwd('models', '1CRN.pdb'))
  assert.equal(await resolveFetchTarget(CWD, '/tmp/1atp.ent', pdb), '/tmp/1atp.ent')

  const cif = resolveSource({ entryId: '1crn', sourceDb: 'rcsb-cif' })
  assert.equal(await resolveFetchTarget(CWD, 'x.mmcif', cif), inCwd('x.mmcif'))
  assert.equal(await resolveFetchTarget(CWD, 'x', cif), inCwd('x.cif'))

  const bcif = resolveSource({ entryId: '1crn', sourceDb: 'rcsb-bcif' })
  assert.equal(await resolveFetchTarget(CWD, 'x.bcif', bcif), inCwd('x.bcif'))

  await withTempDir(async directory => {
    assert.equal(await resolveFetchTarget(CWD, directory, pdb), join(directory, '1CRN.pdb'))
  })
})

test('rejects targets mol_open could not parse as the downloaded format', async () => {
  const pdb = resolveSource({ entryId: '1crn' })
  for (const target of ['', '   ', 'x.txt', 'x.cif', 'x.pdb.gz', 'x.PDB.GZ']) {
    await assert.rejects(resolveFetchTarget(CWD, target, pdb), FetchTargetError, target)
  }
})

test('downloads a direct source into a new directory', async () => {
  await withTempDir(async directory => {
    const target = join(directory, 'nested', '1crn.pdb')
    const payload = new TextEncoder().encode('HEADER    TEST\nEND\n')
    const requests: string[] = []
    const fetchImpl: typeof fetch = async input => {
      requests.push(String(input))
      return new Response(payload, { status: 200 })
    }

    const result = await downloadMoleculeSource({
      source: resolveSource({ entryId: '1crn' }),
      targetPath: target,
      maxBytes: 1024,
      signal: abortSignal(),
      fetchImpl,
    })

    assert.deepEqual(result.bytes, payload)
    assert.equal(result.absolutePath, target)
    assert.equal(result.url, 'https://files.rcsb.org/download/1CRN.pdb')
    assert.deepEqual(new Uint8Array(await readFile(target)), payload)
    assert.deepEqual(requests, ['https://files.rcsb.org/download/1CRN.pdb'])
  })
})

test('follows an AlphaFold-style JSON index to the versioned file', async () => {
  await withTempDir(async directory => {
    const requests: string[] = []
    const fetchImpl: typeof fetch = async input => {
      const url = String(input)
      requests.push(url)
      if (url.endsWith('/api/prediction/P00533')) {
        return new Response(
          JSON.stringify([{ pdbUrl: 'https://alphafold.ebi.ac.uk/files/AF-P00533-F1-model_v6.pdb' }]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    }

    const result = await downloadMoleculeSource({
      source: resolveSource({ entryId: 'P00533', sourceDb: 'alphafold' }),
      targetPath: join(directory, 'af.pdb'),
      maxBytes: 1024,
      signal: abortSignal(),
      fetchImpl,
    })

    assert.equal(result.url, 'https://alphafold.ebi.ac.uk/files/AF-P00533-F1-model_v6.pdb')
    assert.deepEqual([...result.bytes], [1, 2, 3])
    assert.deepEqual(requests, [
      'https://alphafold.ebi.ac.uk/api/prediction/P00533',
      'https://alphafold.ebi.ac.uk/files/AF-P00533-F1-model_v6.pdb',
    ])
  })
})

test('reports HTTP failures without writing a file', async () => {
  await withTempDir(async directory => {
    const target = join(directory, 'missing.pdb')
    const fetchImpl: typeof fetch = async () => new Response('not found', { status: 404, statusText: 'Not Found' })
    await assert.rejects(
      downloadMoleculeSource({
        source: resolveSource({ entryId: '9zzz' }),
        targetPath: target,
        maxBytes: 1024,
        signal: abortSignal(),
        fetchImpl,
      }),
      (error: unknown) => error instanceof SourceFetchError && error.message.includes('HTTP 404'),
    )
    await assert.rejects(access(target))
  })
})

test('rejects oversized downloads without writing a file', async () => {
  await withTempDir(async directory => {
    const target = join(directory, 'big.pdb')
    const fetchImpl: typeof fetch = async () => new Response(new Uint8Array(64), { status: 200 })
    await assert.rejects(
      downloadMoleculeSource({
        source: resolveSource({ entryId: '1crn' }),
        targetPath: target,
        maxBytes: 8,
        signal: abortSignal(),
        fetchImpl,
      }),
      (error: unknown) => error instanceof SourceFetchError && error.message.includes('too large'),
    )
    await assert.rejects(access(target))
  })
})

test('rejects an empty response without writing a file', async () => {
  await withTempDir(async directory => {
    const target = join(directory, 'empty.pdb')
    const fetchImpl: typeof fetch = async () => new Response(new Uint8Array(0), { status: 200 })
    await assert.rejects(
      downloadMoleculeSource({
        source: resolveSource({ entryId: '1crn' }),
        targetPath: target,
        maxBytes: 1024,
        signal: abortSignal(),
        fetchImpl,
      }),
      (error: unknown) => error instanceof SourceFetchError && error.message.includes('empty file'),
    )
    await assert.rejects(access(target))
  })
})

test('rejects non-HTTPS index URLs and missing index fields', async () => {
  const source = resolveSource({ entryId: 'P00533', sourceDb: 'alphafold' })
  await assert.rejects(
    downloadMoleculeSource({
      source,
      targetPath: '/tmp/af.pdb',
      maxBytes: 1024,
      signal: abortSignal(),
      fetchImpl: textFetch('[{"pdbUrl":"http://evil.example/af.pdb"}]'),
    }),
    (error: unknown) => error instanceof SourceFetchError && error.message.includes('non-HTTPS'),
  )
  await assert.rejects(
    downloadMoleculeSource({
      source,
      targetPath: '/tmp/af.pdb',
      maxBytes: 1024,
      signal: abortSignal(),
      fetchImpl: textFetch('{"unexpected":true}'),
    }),
    (error: unknown) => error instanceof SourceFetchError && error.message.includes('0.pdbUrl'),
  )
  await assert.rejects(
    downloadMoleculeSource({
      source,
      targetPath: '/tmp/af.pdb',
      maxBytes: 1024,
      signal: abortSignal(),
      fetchImpl: textFetch('not json'),
    }),
    (error: unknown) => error instanceof SourceFetchError && error.message.includes('invalid JSON'),
  )
})

test('propagates cancellation instead of wrapping it', async () => {
  const controller = new AbortController()
  controller.abort()
  const fetchImpl: typeof fetch = async () => {
    throw new DOMException('aborted', 'AbortError')
  }
  await assert.rejects(
    downloadMoleculeSource({
      source: resolveSource({ entryId: '1crn' }),
      targetPath: '/tmp/1crn.pdb',
      maxBytes: 1024,
      signal: controller.signal,
      fetchImpl,
    }),
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  )
})
