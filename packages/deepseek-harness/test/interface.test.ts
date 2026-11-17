import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parseResidueRanges } from '@gcszhn/mol4agent-core/protocol'
import { findInterfaceResidues } from '../src/host/interface.ts'

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

test('4zqk chains A/B at 6 A produce one compact range per chain', () => {
  const result = interfaceOf(['A'], ['B'], 6)
  assert.equal(result.cutoff, 6)
  assert.equal(result.residues.length, 54)
  assert.equal(result.contactPairs, 82)
  assert.deepEqual(result.ranges.map(range => range.chain), ['A', 'B'])
  for (const range of result.ranges) assert.match(range.range, /^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/u)
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

test('every range covers exactly the reported interface residues', () => {
  const result = interfaceOf(['A'], ['B'], 6)
  const covered: string[] = []
  for (const range of result.ranges) {
    for (const span of parseResidueRanges(range.range)) {
      for (let index = span.start; index <= span.end; index += 1) {
        covered.push(`${range.chain}:${String(index)}`)
      }
    }
  }
  assert.deepEqual(covered, keys(result))
})

test('unknown chains yield an empty interface', () => {
  const result = interfaceOf(['X'], ['Y'], 6)
  assert.deepEqual(result.residues, [])
  assert.deepEqual(result.ranges, [])
  assert.equal(result.contactPairs, 0)
})

test('adjacent residues merge into one per-chain range', () => {
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
    { chain: 'A', range: '1-3,5' },
    { chain: 'B', range: '10' },
  ])
})
