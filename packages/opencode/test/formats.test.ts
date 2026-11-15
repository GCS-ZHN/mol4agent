import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatOfFile, isBinaryFormat, isGzipFile } from '../src/formats.ts'

test('suffix aliases', () => {
  assert.equal(formatOfFile('x.ent'), 'pdb')
  assert.equal(formatOfFile('x.sd'), 'sdf')
  assert.equal(formatOfFile('x.mcif'), 'mmcif')
  assert.equal(formatOfFile('x.cif'), 'mmcif')
  assert.equal(formatOfFile('x.mol2'), 'mol2')
})

test('case and .gz', () => {
  assert.equal(formatOfFile('X.PDB'), 'pdb')
  assert.equal(formatOfFile('x.pdb.gz'), 'pdb')
  assert.equal(formatOfFile('x.cif.GZ'), 'mmcif')
  assert.equal(formatOfFile('x.bcif.gz'), 'bcif')
  assert.equal(formatOfFile('/abs/dir/fixtures/water.gro.gz'), 'gro')
})

test('unknown suffixes', () => {
  assert.equal(formatOfFile('x.md'), undefined)
  assert.equal(formatOfFile('x.gz'), undefined)
  assert.equal(formatOfFile('noext'), undefined)
  assert.equal(formatOfFile(''), undefined)
})

test('isGzipFile', () => {
  assert.equal(isGzipFile('x.pdb.gz'), true)
  assert.equal(isGzipFile('x.pdb'), false)
  assert.equal(isGzipFile('/a/b/x.sdf.GZ'), true)
})

test('isBinaryFormat', () => {
  assert.equal(isBinaryFormat('bcif'), true)
  assert.equal(isBinaryFormat('pdb'), false)
})
