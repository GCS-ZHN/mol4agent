import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EXTENSION_FORMATS,
  GZIP_EXTENSIONS,
  PREVIEW_EXTENSIONS,
  baseNameOf,
  formatOfFile,
  isGzipFile,
  previewFileExtensions,
} from '../src/formats.ts'

test('maps base and gzip suffixes to core formats', () => {
  assert.equal(formatOfFile('/tmp/1crn.pdb'), 'pdb')
  assert.equal(formatOfFile('C:\\data\\model.PDB'), 'pdb')
  assert.equal(formatOfFile('x.cif'), 'mmcif')
  assert.equal(formatOfFile('x.mmcif'), 'mmcif')
  assert.equal(formatOfFile('x.mcif'), 'mmcif')
  assert.equal(formatOfFile('x.bcif'), 'bcif')
  assert.equal(formatOfFile('x.sdf'), 'sdf')
  assert.equal(formatOfFile('x.unknown'), undefined)
  assert.equal(formatOfFile('x'), undefined)
  assert.equal(formatOfFile('x.gz'), undefined)

  for (const extension of GZIP_EXTENSIONS) {
    assert.equal(
      formatOfFile(`model.${extension}`),
      formatOfFile(`model.${extension.slice(0, -3)}`),
      extension,
    )
  }
  assert.equal(formatOfFile('1crn.pdb.gz'), 'pdb')
  assert.equal(formatOfFile('1crn.cif.gz'), 'mmcif')
  assert.equal(formatOfFile('ligand.sdf.gz'), 'sdf')
  assert.equal(formatOfFile('complex.bcif.gz'), 'bcif')
})

test('claims gzip file-viewer extensions', () => {
  assert.deepEqual(PREVIEW_EXTENSIONS, [...Object.keys(EXTENSION_FORMATS), ...GZIP_EXTENSIONS])
  const claimed = previewFileExtensions()
  assert.ok(claimed.includes('.pdb'))
  assert.ok(claimed.includes('.pdb.gz'))
  assert.ok(claimed.includes('.bcif.gz'))
  assert.ok(claimed.every(extension => extension.startsWith('.')))
})

test('detects gzip paths case-insensitively', () => {
  assert.equal(isGzipFile('A.PDB.GZ'), true)
  assert.equal(isGzipFile('C:\\data\\model.cif.gz'), true)
  assert.equal(isGzipFile('a.pdb'), false)
  assert.equal(isGzipFile('a.gz.pdb'), false)
})

test('returns the display basename for gzip paths', () => {
  assert.equal(baseNameOf('/tmp/a/b.pdb.gz'), 'b.pdb.gz')
  assert.equal(baseNameOf('C:\\tmp\\b.pdb.gz'), 'b.pdb.gz')
})
