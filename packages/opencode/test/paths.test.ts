import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { resolveMoleculeFile } from '../src/paths.ts'

const PDB = 'ATOM      1  N   ALA A   1       0.000   0.000   0.000  1.00  0.00           N\nEND\n'
const LIMIT = 1024 * 1024

let root = ''

async function workspace(): Promise<string> {
  if (root === '') root = await mkdtemp(join(tmpdir(), 'mol4agent-opencode-'))
  return root
}

after(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true })
})

const signal = (): AbortSignal => new AbortController().signal

test('resolves a relative path against cwd', async () => {
  const cwd = await workspace()
  await writeFile(join(cwd, 'sample.pdb'), PDB)
  const file = await resolveMoleculeFile(cwd, 'sample.pdb', LIMIT, signal())
  assert.equal(file.absolutePath, join(cwd, 'sample.pdb'))
  assert.equal(file.format, 'pdb')
  assert.equal(file.label, 'sample.pdb')
  assert.equal(new TextDecoder().decode(file.bytes), PDB)
})

test('accepts an absolute path and trims whitespace', async () => {
  const cwd = await workspace()
  const path = join(cwd, 'absolute.sdf')
  await writeFile(path, 'aspirin\n')
  const file = await resolveMoleculeFile('/elsewhere', `  ${path}  `, LIMIT, signal())
  assert.equal(file.absolutePath, path)
  assert.equal(file.format, 'sdf')
  assert.equal(file.label, 'absolute.sdf')
})

test('decompresses .gz and keeps the inner format', async () => {
  const cwd = await workspace()
  await writeFile(join(cwd, 'packed.pdb.gz'), gzipSync(Buffer.from(PDB)))
  const file = await resolveMoleculeFile(cwd, 'packed.pdb.gz', LIMIT, signal())
  assert.equal(file.format, 'pdb')
  assert.equal(file.label, 'packed.pdb.gz')
  assert.equal(new TextDecoder().decode(file.bytes), PDB)
})

test('rejects empty, unsupported, missing, and non-file paths', async () => {
  const cwd = await workspace()
  await assert.rejects(
    resolveMoleculeFile(cwd, '   ', LIMIT, signal()),
    /path must be a non-empty string/u,
  )
  await assert.rejects(
    resolveMoleculeFile(cwd, 'notes.md', LIMIT, signal()),
    /unsupported molecular file type: notes\.md/u,
  )
  await assert.rejects(
    resolveMoleculeFile(cwd, 'missing.pdb', LIMIT, signal()),
    /cannot read .*missing\.pdb/u,
  )
  await mkdir(join(cwd, 'folder.pdb'))
  await assert.rejects(
    resolveMoleculeFile(cwd, 'folder.pdb', LIMIT, signal()),
    /not a regular file: .*folder\.pdb/u,
  )
})

test('enforces the compressed size limit', async () => {
  const cwd = await workspace()
  await writeFile(join(cwd, 'large.pdb'), PDB)
  await assert.rejects(
    resolveMoleculeFile(cwd, 'large.pdb', 8, signal()),
    /file is too large \(\d+ bytes; limit 8\)/u,
  )
})

test('caps gzip decompression output', async () => {
  const cwd = await workspace()
  await writeFile(join(cwd, 'bomb.pdb.gz'), gzipSync(Buffer.alloc(4096, 0x41)))
  await assert.rejects(
    resolveMoleculeFile(cwd, 'bomb.pdb.gz', 256, signal()),
    /could not decompress .*limit 256 bytes/u,
  )
})

test('respects an aborted signal', async () => {
  const cwd = await workspace()
  await writeFile(join(cwd, 'abort.pdb'), PDB)
  await assert.rejects(resolveMoleculeFile(cwd, 'abort.pdb', LIMIT, AbortSignal.abort()))
})
