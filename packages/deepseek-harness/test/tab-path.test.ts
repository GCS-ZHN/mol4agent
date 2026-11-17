import assert from 'node:assert/strict'
import test from 'node:test'
import { sessionFileAddress, sessionPathOf } from '../src/client/address.ts'
import { canonicalTabPath } from '../src/tab-path.ts'

test('canonicalizes Windows separators and drive letters', () => {
  assert.equal(canonicalTabPath('D:\\xtalpi\\5jds.pdb'), 'D:/xtalpi/5jds.pdb')
  assert.equal(canonicalTabPath('d:/xtalpi/5jds.pdb'), 'D:/xtalpi/5jds.pdb')
  assert.equal(canonicalTabPath('D:/xtalpi/5jds.pdb'), 'D:/xtalpi/5jds.pdb')
  assert.equal(canonicalTabPath('\\\\server\\share\\5jds.pdb'), '//server/share/5jds.pdb')
  assert.equal(canonicalTabPath('relative\\models\\a.pdb'), 'relative/models/a.pdb')
  assert.equal(canonicalTabPath('/Users/gcs/5jds.pdb'), '/Users/gcs/5jds.pdb')
})

test('the client address round trip matches the canonical projection key', () => {
  const paths = [
    'C:\\xtalpi\\5jds.pdb',
    'c:\\xtalpi\\5jds.pdb',
    'D:/xtalpi/#1/5jds copy.pdb',
    '\\\\server\\share\\5jds.pdb',
    '/Users/gcs/xtalpi/5jds.pdb',
  ]
  for (const path of paths) {
    const key = canonicalTabPath(path)
    const address = sessionFileAddress('session-1', key)
    assert.equal(sessionPathOf(address), key, path)
    assert.equal(canonicalTabPath(sessionPathOf(address) ?? ''), key, path)
  }
})

test('a native Windows tab argument and the client path are one key', () => {
  const native = 'D:\\xtalpi\\5jds.pdb'
  const fromAddress = sessionPathOf(sessionFileAddress('session-1', canonicalTabPath(native)))
  assert.equal(canonicalTabPath(fromAddress ?? ''), canonicalTabPath(native))
})
