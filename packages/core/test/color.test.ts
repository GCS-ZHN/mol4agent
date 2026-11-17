import assert from 'node:assert/strict'
import test from 'node:test'
import { COLOR_SYNTAX, formatColor, parseColor } from '../src/color.ts'

test('parseColor accepts CSS names case-insensitively', () => {
  assert.equal(parseColor('red'), 0xff0000)
  assert.equal(parseColor(' Red '), 0xff0000)
  assert.equal(parseColor('lightgrey'), 0xd3d3d3)
  assert.equal(parseColor('lightgray'), 0xd3d3d3)
  assert.equal(parseColor('white'), 0xffffff)
  assert.equal(parseColor('rebeccapurple'), 0x663399)
})

test('parseColor accepts hex, 0x, and bare hex forms', () => {
  assert.equal(parseColor('#f00'), 0xff0000)
  assert.equal(parseColor('#FF0000'), 0xff0000)
  assert.equal(parseColor('#ff000080'), 0xff0000)
  assert.equal(parseColor('#f008'), 0xff0000)
  assert.equal(parseColor('0xff0000'), 0xff0000)
  assert.equal(parseColor('0xB0B0B0'), 0xb0b0b0)
  assert.equal(parseColor('B0B0B0'), 0xb0b0b0)
  assert.equal(parseColor('0f0'), 0x00ff00)
})

test('parseColor accepts rgb()/rgba() with numbers, percentages, and alpha', () => {
  assert.equal(parseColor('rgb(255, 0, 0)'), 0xff0000)
  assert.equal(parseColor('RGB(100%, 0%, 0%)'), 0xff0000)
  assert.equal(parseColor('rgb(255 0 0)'), 0xff0000)
  assert.equal(parseColor('rgba(255, 0, 0, 0.5)'), 0xff0000)
  assert.equal(parseColor('rgb(255 0 0 / 50%)'), 0xff0000)
  // CSS clamps out-of-range channels.
  assert.equal(parseColor('rgb(300, -10, 0)'), 0xff0000)
})

test('parseColor masks 24-bit integers', () => {
  assert.equal(parseColor(0), 0x000000)
  assert.equal(parseColor(255), 0x0000ff)
  assert.equal(parseColor(16711680), 0xff0000)
  assert.equal(parseColor(0xB0B0B0), 0xb0b0b0)
  assert.equal(parseColor(0x1ff0000), 0xff0000)
})

test('parseColor rejects malformed colours with the accepted syntax', () => {
  for (const value of ['', 'nope', '#12', '#ggg', 'rgb(1,2)', 'rgb(1,2,3foo)', 'rgb(1,2,3,4,5)', 'rgba(1,2,3 / nope)', 1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, null]) {
    assert.throws(() => parseColor(value), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /invalid color/u)
      assert.ok(error.message.includes(COLOR_SYNTAX))
      return true
    }, String(value))
  }
})

test('formatColor renders normalized hex', () => {
  assert.equal(formatColor(0xff0000), '#ff0000')
  assert.equal(formatColor(0x0000ff), '#0000ff')
  assert.equal(formatColor(0xd3d3d3), '#d3d3d3')
})
