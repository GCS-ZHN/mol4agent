import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { summarizeStructure } from '@gcszhn/mol4agent-core/parse'
import { formatOfFile, isGzipFile } from '../src/formats.ts'
import { gunzipBytes } from '../src/host/gzip.ts'

const root = new URL('../../../fixtures/formats/', import.meta.url)
const read = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(name, root)))

const expected = [
  ['1crn.pdb', 'pdb'],
  ['1crn.ent', 'pdb'],
  ['1crn.pdbqt', 'pdbqt'],
  ['1crn.pqr', 'pqr'],
  ['1crn.cif', 'mmcif'],
  ['1crn.mmcif', 'mmcif'],
  ['1crn.mcif', 'mmcif'],
  ['1crn.bcif', 'bcif'],
  ['aspirin.mol', 'mol'],
  ['aspirin.sdf', 'sdf'],
  ['aspirin.sd', 'sdf'],
  ['water.mol2', 'mol2'],
  ['water.xyz', 'xyz'],
  ['water.gro', 'gro'],
] as const

test('every normal fixture and its gzip sibling is recognized and decodes identically', () => {
  for (const [name, format] of expected) {
    assert.equal(formatOfFile(name), format, name)
    assert.equal(isGzipFile(name), false, name)

    const normal = read(name)
    const gzName = `${name}.gz`
    assert.equal(formatOfFile(gzName), format, gzName)
    assert.equal(isGzipFile(gzName), true, gzName)
    const decoded = gunzipBytes(read(gzName), 8 * 1024 * 1024)
    assert.deepEqual(decoded, normal, name)

    if (format === 'bcif') {
      assert.equal(decoded[0], 0x83, name)
      assert.throws(
        () => summarizeStructure({ data: decoded, format }),
        (error: unknown) => (error as { code?: string }).code === 'SUMMARY_UNSUPPORTED',
      )
      continue
    }
    const normalSummary = summarizeStructure({ data: normal, format, label: name })
    const gzipSummary = summarizeStructure({ data: decoded, format, label: name })
    assert.deepEqual(gzipSummary, normalSummary, name)
  }
})

test('the fixture directory covers every non-gzip fixture with a gzip sibling', () => {
  const files = readdirSync(root)
  const normal = files.filter(name => name.endsWith('.gz') === false && name.endsWith('.md') === false)
  const gzip = new Set(files.filter(name => name.endsWith('.gz')))
  assert.equal(normal.length, expected.length)
  for (const name of normal) assert.ok(gzip.has(`${name}.gz`), `missing ${name}.gz`)
})
