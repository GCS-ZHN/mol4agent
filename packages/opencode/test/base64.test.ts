import assert from 'node:assert/strict'
import { test } from 'node:test'
import { base64ToBytes, bytesToBase64 } from '../src/base64.ts'

test('encodes a known string', () => {
  assert.equal(bytesToBase64(new TextEncoder().encode('hello')), 'aGVsbG8=')
})

test('round-trips empty and single-chunk inputs', () => {
  for (const bytes of [new Uint8Array(0), new Uint8Array([0]), new Uint8Array([0, 127, 255])]) {
    assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes)
  }
})

test('round-trips every byte value and a multi-chunk input', () => {
  const values = new Uint8Array(256)
  for (let index = 0; index < values.length; index += 1) values[index] = index
  assert.deepEqual(base64ToBytes(bytesToBase64(values)), values)

  // Larger than the 0x8000 chunk, so the spread path is exercised repeatedly.
  const large = new Uint8Array(100_000)
  for (let index = 0; index < large.length; index += 1) large[index] = (index * 31) % 256
  assert.deepEqual(base64ToBytes(bytesToBase64(large)), large)
})

test('decodes the empty string to no bytes', () => {
  assert.deepEqual(base64ToBytes(''), new Uint8Array(0))
})
