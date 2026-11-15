import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { summarizeStructure } from '@gcszhn/mol4agent-core/parse'
import { gunzipBytes as gunzipBrowser } from '../src/client/gzip.ts'
import { gunzipBytes as gunzipHost } from '../src/host/gzip.ts'

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`../../../fixtures/formats/${name}`, import.meta.url)))

test('host gunzip decodes real fixtures and enforces the decompressed limit', () => {
  for (const [name, format] of [
    ['1crn.pdb.gz', 'pdb'],
    ['1crn.cif.gz', 'mmcif'],
    ['aspirin.sdf.gz', 'sdf'],
  ] as const) {
    const decoded = gunzipHost(fixture(name), 8 * 1024 * 1024)
    const summary = summarizeStructure({ data: decoded, format, label: name })
    assert.equal(summary.format, format)
    assert.ok(summary.atomCount > 0, name)
  }
  assert.throws(
    () => gunzipHost(new Uint8Array(gzipSync('x'.repeat(1024))), 16),
    /gzip decompression failed|exceeds/,
  )
  assert.throws(() => gunzipHost(new Uint8Array([1, 2, 3]), 1024), /gzip decompression failed/)
})

test('browser gunzip decodes the same payload and enforces the limit', async t => {
  if (typeof DecompressionStream === 'undefined') {
    t.skip('DecompressionStream is unavailable in this Node runtime')
    return
  }
  const raw = fixture('1crn.pdb')
  const decoded = await gunzipBrowser(new Uint8Array(gzipSync(raw)), 8 * 1024 * 1024)
  assert.deepEqual(decoded, raw)
  await assert.rejects(
    gunzipBrowser(new Uint8Array(gzipSync('x'.repeat(1024))), 16),
    /gzip decompression failed|exceeds/,
  )
  await assert.rejects(gunzipBrowser(new Uint8Array([1, 2, 3]), 1024), /gzip decompression failed/)
})

test('every text format parses after a gzip round trip', () => {
  const atom = 'ATOM      1  CA  ALA A   1       0.000   0.000   0.000  1.00  0.00           C'
  const cases: readonly [string, string][] = [
    ['pdb', `${atom}\n`],
    ['pdbqt', `${atom}\n`],
    ['pqr', `${atom}\n`],
    ['mmcif', 'data_x\nloop_\n_atom_site.group_PDB\n_atom_site.label_comp_id\n_atom_site.auth_asym_id\n_atom_site.auth_seq_id\nATOM ALA A 1\n#\n'],
    ['mol', 'mol\n  1  0  0  0  0  0            999 V2000\n'],
    ['sdf', 'sdf\n  1  0  0  0  0  0            999 V2000\n$$$$\n'],
    ['mol2', '@<TRIPOS>MOLECULE\nx\n@<TRIPOS>ATOM\n1 C1 0 0 0 C.ar 1 LIG 0\n'],
    ['xyz', '1\nx\nC 0 0 0\n'],
    ['gro', 'x\n    1\n    1ALA     1   0.000   0.000   0.000\n   1.000   1.000   1.000\n'],
  ]
  for (const [format, text] of cases) {
    const decoded = gunzipHost(new Uint8Array(gzipSync(text)), 1024 * 1024)
    const summary = summarizeStructure({
      data: decoded,
      format: format as Parameters<typeof summarizeStructure>[0]['format'],
      label: `${format}.gz`,
    })
    assert.equal(summary.format, format)
    assert.ok(summary.atomCount > 0, format)
  }
})
