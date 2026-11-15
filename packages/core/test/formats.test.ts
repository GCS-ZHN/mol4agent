import assert from 'node:assert/strict'
import test from 'node:test'
import { MOL_FORMATS, Mol4AgentError } from '../src/protocol.ts'
import { molstarFormatOf, supportedFormats } from '../src/formats.ts'

test('exposes exactly the supported core formats', () => {
  assert.deepEqual([...supportedFormats()], [...MOL_FORMATS])
})

test('describes parser and binary handling per format', () => {
  assert.deepEqual(molstarFormatOf('pdb'), { parser: 'pdb', binary: false })
  assert.deepEqual(molstarFormatOf('pdbqt'), { parser: 'pdbqt', binary: false })
  assert.deepEqual(molstarFormatOf('pqr'), { parser: 'pqr', binary: false })
  assert.deepEqual(molstarFormatOf('mmcif'), { parser: 'mmcif', binary: false })
  assert.deepEqual(molstarFormatOf('bcif'), { parser: 'mmcif', binary: true, note: 'binary CIF' })
  assert.deepEqual(molstarFormatOf('sdf'), { parser: 'sdf', binary: false })
})

test('rejects an unknown format as a structured error', () => {
  assert.throws(
    () => molstarFormatOf('unknown' as never),
    (error: unknown) => error instanceof Mol4AgentError && error.code === 'UNSUPPORTED_FORMAT',
  )
})
