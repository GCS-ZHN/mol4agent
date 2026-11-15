import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { findInterfaceResidues } from '../src/interface.ts'

const FOUR_ZQK = new Uint8Array(readFileSync(new URL('../../../fixtures/4zqk.pdb', import.meta.url)))

function interfaceOf(chainsA: readonly string[], chainsB: readonly string[], cutoff: number) {
  return findInterfaceResidues(FOUR_ZQK, { chainsA, chainsB, cutoff })
}

function key(residue: { readonly chain: string; readonly index: number }): string {
  return `${residue.chain}:${String(residue.index)}`
}

function keys(result: ReturnType<typeof findInterfaceResidues>): string[] {
  return result.residues.map(key)
}

test('4zqk chains A/B at 6 A', () => {
  const result = interfaceOf(['A'], ['B'], 6)
  assert.equal(result.cutoff, 6)
  assert.equal(result.residues.length, 54)
  assert.equal(result.ranges.length, 20)
  assert.equal(result.contactPairs, 82)
})

test('swapping the two chain groups gives the same interface', () => {
  const forward = interfaceOf(['A'], ['B'], 6)
  const reverse = interfaceOf(['B'], ['A'], 6)
  assert.deepEqual(keys(forward), keys(reverse))
  assert.equal(forward.contactPairs, reverse.contactPairs)
  assert.deepEqual(forward.ranges, reverse.ranges)
})

test('a tighter cutoff is a subset of a looser one', () => {
  const tight = interfaceOf(['A'], ['B'], 4)
  const loose = interfaceOf(['A'], ['B'], 6)
  const looseKeys = new Set(keys(loose))
  for (const residue of tight.residues) assert.ok(looseKeys.has(key(residue)))
  assert.ok(tight.residues.length < loose.residues.length)
  assert.ok(tight.contactPairs <= loose.contactPairs)
})

test('residues are sorted and every range covers contiguous residues', () => {
  const result = interfaceOf(['A'], ['B'], 6)
  for (let index = 1; index < result.residues.length; index += 1) {
    const previous = result.residues[index - 1]!
    const current = result.residues[index]!
    assert.ok(
      previous.chain < current.chain
      || (previous.chain === current.chain && previous.index < current.index),
      `unexpected order at ${key(previous)} -> ${key(current)}`,
    )
  }
  const covered: string[] = []
  for (const range of result.ranges) {
    assert.ok(range.start <= range.end)
    for (let index = range.start; index <= range.end; index += 1) covered.push(`${range.chain}:${String(index)}`)
  }
  assert.deepEqual(covered, keys(result))
})

test('unknown chains yield an empty interface', () => {
  const result = interfaceOf(['X'], ['Y'], 6)
  assert.deepEqual(result.residues, [])
  assert.deepEqual(result.ranges, [])
  assert.equal(result.contactPairs, 0)
})

test('hydrogens do not count as contacts', () => {
  const atom = (
    serial: number,
    name: string,
    chain: string,
    index: number,
    x: number,
    y: number,
    z: number,
    element: string,
  ): string => 'ATOM  '
    + String(serial).padStart(5) + ' '
    + name.padEnd(4).slice(0, 4) + ' '
    + 'ALA'.padStart(3) + ' '
    + chain
    + String(index).padStart(4)
    + '    '
    + x.toFixed(3).padStart(8)
    + y.toFixed(3).padStart(8)
    + z.toFixed(3).padStart(8)
    + '  1.00  0.00          '
    + element.padStart(2)

  // A is 10 A from B's heavy atom, but A's hydrogen sits 1 A away.
  const far = [
    atom(1, 'N', 'A', 1, 0, 0, 0, 'N'),
    atom(2, 'H', 'A', 1, 10, 0, 0, 'H'),
    atom(3, 'N', 'B', 1, 11, 0, 0, 'N'),
    'END',
  ].join('\n')
  const farResult = findInterfaceResidues(new TextEncoder().encode(far), { chainsA: ['A'], chainsB: ['B'], cutoff: 6 })
  assert.deepEqual(farResult.residues, [])

  const near = [
    atom(1, 'N', 'A', 1, 0, 0, 0, 'N'),
    atom(2, 'H', 'A', 1, 10, 0, 0, 'H'),
    atom(3, 'N', 'B', 1, 5, 0, 0, 'N'),
    'END',
  ].join('\n')
  const nearResult = findInterfaceResidues(new TextEncoder().encode(near), { chainsA: ['A'], chainsB: ['B'], cutoff: 6 })
  assert.deepEqual(keys(nearResult), ['A:1', 'B:1'])
  assert.equal(nearResult.contactPairs, 1)
})

test('adjacent residues merge into one range', () => {
  const atom = (chain: string, index: number, x: number): string => 'ATOM  '
    + '  1'.padStart(5) + ' '
    + 'CA'.padEnd(4) + ' '
    + 'ALA' + ' '
    + chain
    + String(index).padStart(4)
    + '    '
    + x.toFixed(3).padStart(8) + '   0.000   0.000  1.00  0.00          ' + ' C'

  const lines = [
    atom('A', 1, 0),
    atom('A', 2, 1),
    atom('A', 3, 2),
    atom('A', 5, 4),
    atom('B', 10, 3),
    'END',
  ]
  const result = findInterfaceResidues(new TextEncoder().encode(lines.join('\n')), {
    chainsA: ['A'],
    chainsB: ['B'],
    cutoff: 3,
  })
  assert.deepEqual(result.ranges, [
    { chain: 'A', start: 1, end: 3 },
    { chain: 'A', start: 5, end: 5 },
    { chain: 'B', start: 10, end: 10 },
  ])
})
