import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MOLECULAR_HREF, basenameOf, hrefToPath, isPathLike, isRemoteLink } from '../src/gui/links.ts'

test('decodes file URLs without rewriting another OS drive path', () => {
  assert.equal(hrefToPath('file:///data/corp/example.pdb'), '/data/corp/example.pdb')
  assert.equal(hrefToPath('file:///C:/data/example.pdb'), '/C:/data/example.pdb')
  assert.equal(hrefToPath('file:///data/with%20space.pdb'), '/data/with space.pdb')
  assert.equal(hrefToPath('example.pdb'), 'example.pdb')
})

test('a remote link is a URL, not a Windows drive path or a file URL', () => {
  assert.equal(isRemoteLink('https://example.test/1crn.pdb'), true)
  assert.equal(isRemoteLink('mailto:someone@example.test'), true)
  assert.equal(isRemoteLink('C:\\data\\example.pdb'), false)
  assert.equal(isRemoteLink('C:/data/example.pdb'), false)
  assert.equal(isRemoteLink('file:///data/example.pdb'), false)
  assert.equal(isRemoteLink('/data/example.pdb'), false)
})

test('path-like text needs a separator', () => {
  assert.equal(isPathLike('/data/example.pdb'), true)
  assert.equal(isPathLike('example.pdb'), false)
  assert.equal(isPathLike('C:\\data\\example.pdb'), true)
})

test('basename handles POSIX, Windows, and file URLs', () => {
  assert.equal(basenameOf('/data/a/1crn.pdb'), '1crn.pdb')
  assert.equal(basenameOf('C:\\data\\a\\1crn.pdb'), '1crn.pdb')
  assert.equal(basenameOf('file:///data/a/1crn.pdb'), '1crn.pdb')
})

test('claims molecular files, including gzip variants', () => {
  for (const name of ['a.pdb', 'a.ent', 'a.cif', 'a.mmcif', 'a.sdf', 'a.mol2', 'a.xyz', 'a.gro', 'a.pdb.gz']) {
    assert.equal(MOLECULAR_HREF.test(name), true, name)
  }
  assert.equal(MOLECULAR_HREF.test('notes.md'), false)
  assert.equal(MOLECULAR_HREF.test('a.pdb.txt'), false)
})
