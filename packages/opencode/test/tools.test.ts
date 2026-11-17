import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { StructureSummary } from '@gcszhn/mol4agent-core/protocol'
import { findInterfaceResidues } from '../src/interface.ts'
import {
  assertColorParams,
  describeFile,
  describeSelector,
  describeStyle,
  escapeAttribute,
  formatInterface,
  resolvedColorOf,
  styleOf,
  summarizeSafely,
  tabOf,
  validateSelectorAgainst,
} from '../src/tools.ts'

const CRN = new Uint8Array(readFileSync(new URL('../../../fixtures/1crn.pdb', import.meta.url)))
const CRN_PATH = fileURLToPath(new URL('../../../fixtures/1crn.pdb', import.meta.url))
const ASPIRIN = new Uint8Array(readFileSync(new URL('../../../fixtures/aspirin.sdf', import.meta.url)))

test('styleOf defaults to cartoon / chain-id', () => {
  assert.deepEqual(styleOf({}), { type: 'cartoon', color: 'chain-id' })
})

test('styleOf normalizes colorParams values to 24-bit integers', () => {
  assert.deepEqual(
    styleOf({ type: 'spacefill', color: 'uniform', colorParams: { value: 0x336699 } }),
    { type: 'spacefill', color: 'uniform', colorParams: { value: 0x336699 } },
  )
  assert.deepEqual(
    styleOf({ color: 'uniform', colorParams: { value: 'red' } }),
    { color: 'uniform', colorParams: { value: 0xff0000 } },
  )
  assert.deepEqual(
    styleOf({ color: 'uniform', colorParams: { value: '#ff0000' } }),
    { color: 'uniform', colorParams: { value: 0xff0000 } },
  )
  assert.deepEqual(
    styleOf({ color: 'uniform', colorParams: { value: 'rgb(0, 0, 255)' } }),
    { color: 'uniform', colorParams: { value: 0x0000ff } },
  )
})

test('styleOf rejects unparseable colors and empty colorParams', () => {
  assert.throws(
    () => styleOf({ color: 'uniform', colorParams: { value: 'not-a-colour' } }),
    /invalid color "not-a-colour"/u,
  )
  assert.deepEqual(styleOf({ color: 'uniform', colorParams: {} }), { color: 'uniform' })
})

test('styleOf copies colorParams instead of sharing the object', () => {
  const params = { value: 'red' }
  const style = styleOf({ colorParams: params })
  assert.notEqual(style.colorParams, params)
  assert.deepEqual(style.colorParams, { value: 0xff0000 })
})

test('assertColorParams validates the object shape and the color value', () => {
  assert.doesNotThrow(() => assertColorParams({}))
  assert.doesNotThrow(() => assertColorParams({ value: 'lightgrey' }))
  assert.doesNotThrow(() => assertColorParams({ value: 16711680 }))
  assert.throws(() => assertColorParams(null), /colorParams must be an object/u)
  assert.throws(() => assertColorParams('red'), /colorParams must be an object/u)
  assert.throws(() => assertColorParams(['red']), /colorParams must be an object/u)
  assert.throws(() => assertColorParams({ value: 'nope' }), /invalid color "nope"/u)
})

test('resolvedColorOf returns the normalized hex for a colorParams value', () => {
  assert.equal(resolvedColorOf({ value: 'red' }), '#ff0000')
  assert.equal(resolvedColorOf({ value: '#00F' }), '#0000ff')
  assert.equal(resolvedColorOf({}), undefined)
  assert.equal(resolvedColorOf(undefined), undefined)
  assert.equal(resolvedColorOf(null), undefined)
})

test('describeStyle reports the whole structure or the normalized target', () => {
  assert.equal(describeStyle({}), 'Applied cartoon / chain-id to the whole structure.')
  assert.equal(
    describeStyle({ type: 'ball-and-stick', color: 'element-symbol', target: { kind: 'ligand' } }),
    'Applied ball-and-stick / element-symbol to ligand.',
  )
  assert.equal(
    describeStyle({ target: { kind: 'residues', chain: 'A', start: 26, end: 33 } }),
    'Applied cartoon / chain-id to residues A26-33.',
  )
  assert.throws(() => describeStyle({ target: { kind: 'nope' } }))
})

test('describeStyle echoes the resolved color', () => {
  assert.equal(
    describeStyle({ color: 'uniform', colorParams: { value: 'red' }, target: { kind: 'polymer' } }),
    'Applied cartoon / uniform #ff0000 to polymer.',
  )
  assert.equal(
    describeStyle({ type: 'cartoon', color: 'uniform', colorParams: { value: 0xb0b0b0 } }),
    'Applied cartoon / uniform #b0b0b0 to the whole structure.',
  )
  assert.equal(
    describeStyle({ color: 'uniform', colorParams: {}, target: { kind: 'polymer' } }),
    'Applied cartoon / uniform to polymer.',
  )
  assert.throws(
    () => describeStyle({ color: 'uniform', colorParams: { value: 'not-a-colour' } }),
    /invalid color "not-a-colour"/u,
  )
})

test('describeSelector covers each selector shape', () => {
  assert.equal(describeSelector({ kind: 'all' }), 'all')
  assert.equal(describeSelector({ kind: 'protein' }), 'protein')
  assert.equal(describeSelector({ kind: 'chain', chain: 'A' }), 'chain A')
  assert.equal(describeSelector({ kind: 'residue', index: 42 }), 'residue 42')
  assert.equal(describeSelector({ kind: 'residue', chain: 'A', index: 42 }), 'residue A42')
  assert.equal(describeSelector({ kind: 'residues', start: 1, end: 9 }), 'residues 1-9')
  assert.equal(describeSelector({ kind: 'residues', chain: 'B', start: 1, end: 9 }), 'residues B1-9')
  assert.equal(describeSelector({ kind: 'comp', compId: 'ATP' }), 'residues named ATP')
})

test('describeFile summarizes a PDB without dumping atoms', () => {
  const text = describeFile({ absolutePath: CRN_PATH, format: 'pdb', label: '1crn.pdb', bytes: CRN })
  assert.match(text, /^<structure path="[^"]*1crn\.pdb" format="pdb" bytes="\d+">/u)
  assert.match(text, /atoms: 327, residues: 46, models: 1/u)
  assert.match(text, /- A: polymer, 46 residues, 327 atoms \[ALA, ARG, ASN, ASP, CYS, GLU, GLY, ILE, LEU, PHE, PRO, SER\]/u)
  assert.match(text, /ligands: none/u)
  assert.ok(text.endsWith('</structure>'))
  assert.ok(!text.includes('ATOM'))
})

test('describeFile lists ligands for a small molecule', () => {
  const text = describeFile({ absolutePath: '/x/aspirin.sdf', format: 'sdf', label: 'aspirin.sdf', bytes: ASPIRIN })
  assert.match(text, /atoms: 21, residues: 1, models: 1/u)
  assert.match(text, /ligands: 2244 x1/u)
})

test('describeFile still describes an unparseable file', () => {
  const text = describeFile({
    absolutePath: '/x/empty.pdb',
    format: 'pdb',
    label: 'empty.pdb',
    bytes: new TextEncoder().encode('nothing here\n'),
  })
  assert.match(text, /atoms: 0, residues: 0/u)
  assert.match(text, /\(none\)/u)
})

test('summarizeSafely returns undefined instead of throwing', () => {
  assert.equal(summarizeSafely(new Uint8Array([1, 2, 3, 4]), 'bcif'), undefined)
  const summary = summarizeSafely(CRN, 'pdb')
  assert.equal(summary?.atomCount, 327)
})

test('escapeAttribute escapes markup characters', () => {
  assert.equal(escapeAttribute('a&b"c<d'), 'a&amp;b&quot;c&lt;d')
})

test('tabOf reads and trims an optional tab path', () => {
  assert.equal(tabOf(undefined), undefined)
  assert.equal(tabOf({}), undefined)
  assert.equal(tabOf({ tab: '   ' }), undefined)
  assert.equal(tabOf({ tab: 42 }), undefined)
  assert.equal(tabOf({ tab: '  /x/a.pdb ' }), '/x/a.pdb')
})

test('formatInterface summarizes ranges and embeds JSON', () => {
  const result = findInterfaceResidues(CRN, { chainsA: ['A'], chainsB: ['A'], cutoff: 3 })
  const text = formatInterface('1crn.pdb', result)
  const [head, ...rest] = text.split('\n')
  assert.equal(
    head,
    `Interface of 1crn.pdb at 3 A: ${String(result.residues.length)} residues, `
    + `${String(result.ranges.length)} ranges (${String(result.contactPairs)} residue pairs).`,
  )
  const jsonLine = rest.find(line => line.startsWith('JSON: '))
  assert.ok(jsonLine !== undefined)
  const parsed = JSON.parse(jsonLine.slice('JSON: '.length)) as {
    cutoff: number
    residues: unknown
    ranges: unknown
  }
  assert.equal(parsed.cutoff, 3)
  assert.deepEqual(parsed.residues, result.residues)
  assert.deepEqual(parsed.ranges, result.ranges)
})

test('formatInterface explains an empty interface', () => {
  const result = findInterfaceResidues(CRN, { chainsA: ['Z'], chainsB: ['Y'], cutoff: 6 })
  assert.equal(formatInterface('1crn.pdb', result), 'No interface residues within 6 A for 1crn.pdb.')
})

test('validateSelectorAgainst accepts existing chains and components', () => {
  const summary = summarizeSafely(CRN, 'pdb')
  validateSelectorAgainst(summary, CRN, 'pdb', { kind: 'chain', chain: 'A' })
  validateSelectorAgainst(summary, CRN, 'pdb', { kind: 'comp', compId: 'ALA' })
  validateSelectorAgainst(summary, CRN, 'pdb', { kind: 'residue', index: 12 })
  validateSelectorAgainst(summary, CRN, 'pdb', { kind: 'residues', start: 1, end: 46 })
  validateSelectorAgainst(summary, CRN, 'pdb', { kind: 'all' })
  validateSelectorAgainst(summary, CRN, 'pdb', { kind: 'schema', schema: { label_asym_id: 'A' } })
})

test('validateSelectorAgainst rejects unknown chains, components, and ranges', () => {
  const summary = summarizeSafely(CRN, 'pdb')
  assert.throws(
    () => validateSelectorAgainst(summary, CRN, 'pdb', { kind: 'chain', chain: 'Z' }),
    /chain "Z" does not exist; available chains: A/u,
  )
  assert.throws(
    () => validateSelectorAgainst(summary, CRN, 'pdb', { kind: 'comp', compId: 'NOPE' }),
    /component "NOPE" does not exist/u,
  )
  assert.throws(
    () => validateSelectorAgainst(summary, CRN, 'pdb', { kind: 'residues', start: 400, end: 500 }),
    /do not intersect structure \(parsed residue range 1-46\)/u,
  )
  assert.throws(
    () => validateSelectorAgainst(summary, CRN, 'pdb', { kind: 'residues', chain: 'Z', start: 1, end: 2 }),
    /chain "Z" does not exist/u,
  )
})

test('validateSelectorAgainst skips validation for an incomplete summary', () => {
  const incomplete: StructureSummary = {
    format: 'pdb',
    label: 'x.pdb',
    atomCount: 0,
    residueCount: 0,
    modelCount: 0,
    chains: [],
    ligands: [],
    complete: false,
  }
  validateSelectorAgainst(incomplete, CRN, 'pdb', { kind: 'chain', chain: 'Z' })
  validateSelectorAgainst(undefined, CRN, 'pdb', { kind: 'residues', start: 400, end: 500 })
})
