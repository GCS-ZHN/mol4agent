import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { summarizeStructure } from '@gcszhn/mol4agent-core/parse'
import { BINARY_EXTENSIONS, GZIP_EXTENSIONS, PREVIEW_EXTENSIONS, formatOfFile, isGzipFile } from '../src/formats.ts'
import { gunzipBytes as gunzipHost } from '../src/host/gzip.ts'
import { gunzipBytes as gunzipBrowser } from '../src/client/gzip.ts'

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../../../fixtures/${name}`, import.meta.url)))

test('recognizes gzip variants and maps them back to the base format', () => {
  for (const extension of GZIP_EXTENSIONS) {
    assert.equal(formatOfFile(`model.${extension}`), formatOfFile(`model.${extension.slice(0, -3)}`))
  }
  assert.equal(formatOfFile('1crn.pdb.gz'), 'pdb')
  assert.equal(formatOfFile('1crn.cif.gz'), 'mmcif')
  assert.equal(formatOfFile('ligand.sdf.gz'), 'sdf')
  assert.equal(formatOfFile('ligand.mol.gz'), 'mol')
  assert.equal(formatOfFile('structure.xyz.gz'), 'xyz')
  assert.equal(formatOfFile('complex.bcif.gz'), 'bcif')
  assert.equal(isGzipFile('A.PDB.GZ'), true)
  assert.equal(isGzipFile('a.pdb'), false)
  assert.ok(PREVIEW_EXTENSIONS.includes('pdb.gz'))
  assert.ok(BINARY_EXTENSIONS.includes('pdb.gz'))
  assert.ok(BINARY_EXTENSIONS.includes('bcif.gz'))
})

test('host gunzip decodes real fixture bytes and enforces the limit', () => {
  for (const [name, format] of [
    ['1crn.pdb', 'pdb'],
    ['1crn.cif', 'mmcif'],
    ['aspirin.sdf', 'sdf'],
    ['1crn.pdb.gz', 'pdb'],
  ] as const) {
    const raw = fixture(name)
    const source = name.endsWith('.gz') ? raw : new Uint8Array(gzipSync(raw))
    const decoded = gunzipHost(source, 8 * 1024 * 1024)
    const summary = summarizeStructure({ data: decoded, format, label: name })
    assert.equal(summary.format, format)
    assert.ok(summary.atomCount > 0)
  }
  const large = new Uint8Array(gzipSync('x'.repeat(1024)))
  assert.throws(() => gunzipHost(large, 16), /gzip decompression failed|exceeds/)
  assert.throws(() => gunzipHost(new Uint8Array([1, 2, 3]), 1024), /gzip decompression failed/)
})

test('browser gunzip decodes the same payload', async t => {
  if (typeof DecompressionStream === 'undefined') {
    t.skip('DecompressionStream is unavailable in this Node runtime')
    return
  }
  const raw = fixture('1crn.pdb')
  const decoded = await gunzipBrowser(new Uint8Array(gzipSync(raw)), 8 * 1024 * 1024)
  assert.deepEqual(decoded, raw)
  await assert.rejects(
    gunzipBrowser(new Uint8Array(gzipSync(new TextEncoder().encode('x'.repeat(1024)))), 16),
    /gzip decompression failed|exceeds/,
  )
  await assert.rejects(gunzipBrowser(new Uint8Array([1, 2, 3]), 1024), /gzip decompression failed/)
})

test('every text format parses after gzip round-trip', () => {
  const atom = 'ATOM      1  CA  ALA A   1       0.000   0.000   0.000  1.00  0.00           C'
  const cases: readonly [string, string, string][] = [
    ['pdb', 'pdb', `${atom}\n`],
    ['pdbqt', 'pdbqt', `${atom}\n`],
    ['pqr', 'pqr', `${atom}\n`],
    ['mmcif', 'mmcif', 'data_x\nloop_\n_atom_site.group_PDB\n_atom_site.label_comp_id\n_atom_site.auth_asym_id\n_atom_site.auth_seq_id\nATOM ALA A 1\n#\n'],
    ['mol', 'mol', 'mol\n  1  0  0  0  0  0            999 V2000\n'],
    ['sdf', 'sdf', 'sdf\n  1  0  0  0  0  0            999 V2000\n$$$$\n'],
    ['mol2', 'mol2', '@<TRIPOS>MOLECULE\nx\n@<TRIPOS>ATOM\n1 C1 0 0 0 C.ar 1 LIG 0\n'],
    ['xyz', 'xyz', '1\nx\nC 0 0 0\n'],
    ['gro', 'gro', 'x\n    1ALA     1   0.000   0.000   0.000\n   1.000   1.000   1.000\n'],
  ]
  for (const [name, format, text] of cases) {
    const decoded = gunzipHost(new Uint8Array(gzipSync(text)), 1024 * 1024)
    const summary = summarizeStructure({ data: decoded, format, label: `${name}.gz` })
    assert.equal(summary.format, format, name)
    assert.ok(summary.atomCount > 0, name)
  }
})
