import assert from 'node:assert/strict'
import test from 'node:test'
import { BINARY_EXTENSIONS, EXTENSION_FORMATS, GZIP_EXTENSIONS, PREVIEW_EXTENSIONS, baseNameOf, formatOfFile, isGzipFile } from '../src/formats.ts'

test('maps claimed suffixes to core formats', () => {
  assert.equal(formatOfFile('/tmp/7czd.pdb'), 'pdb')
  assert.equal(formatOfFile('C:\\data\\model.PDB'), 'pdb')
  assert.equal(formatOfFile('x.cif'), 'mmcif')
  assert.equal(formatOfFile('x.mmcif'), 'mmcif')
  assert.equal(formatOfFile('x.mcif'), 'mmcif')
  assert.equal(formatOfFile('x.bcif'), 'bcif')
  assert.equal(formatOfFile('x.sdf'), 'sdf')
  assert.equal(formatOfFile('x.unknown'), undefined)
  assert.equal(formatOfFile('x'), undefined)
  assert.deepEqual(BINARY_EXTENSIONS, ['bcif', ...GZIP_EXTENSIONS])
  assert.deepEqual(PREVIEW_EXTENSIONS, [...Object.keys(EXTENSION_FORMATS), ...GZIP_EXTENSIONS])
  assert.equal(isGzipFile('x.pdb.gz'), true)
})

test('returns the display basename', () => {
  assert.equal(baseNameOf('/tmp/a/b.pdb'), 'b.pdb')
  assert.equal(baseNameOf('C:\\tmp\\b.pdb'), 'b.pdb')
})
