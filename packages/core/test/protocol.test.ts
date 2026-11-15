import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MOL_FORMATS,
  Mol4AgentError,
  PRESETS,
  REPRESENTATION_TYPES,
  COLOR_THEMES,
  isMolCommandOp,
  isMolFormat,
  isPresetName,
  isStructureData,
} from '../src/protocol.ts'

test('format and preset tables stay closed', () => {
  assert.deepEqual([...MOL_FORMATS], ['pdb', 'pdbqt', 'pqr', 'mmcif', 'bcif', 'mol', 'sdf', 'mol2', 'xyz', 'gro'])
  assert.deepEqual([...PRESETS], ['default', 'auto', 'illustrative', 'atomic-detail', 'polymer-and-ligand'])
  assert.deepEqual([...REPRESENTATION_TYPES], ['cartoon', 'ball-and-stick', 'licorice', 'spacefill', 'line', 'point', 'surface', 'gaussian-surface', 'molecular-surface'])
  assert.deepEqual([...COLOR_THEMES], ['chain-id', 'element-symbol', 'residue-name', 'uniform', 'secondary-structure', 'entity-id', 'molecule-type', 'hydrophobicity'])
  assert.equal(isMolFormat('mmcif'), true)
  assert.equal(isMolFormat('MMCIF'), false)
  assert.equal(isPresetName('illustrative'), true)
  assert.equal(isPresetName('all-models'), false)
})

test('command and structure guards reject malformed input', () => {
  assert.equal(isMolCommandOp('represent'), true)
  assert.equal(isMolCommandOp('load'), false)
  assert.equal(isStructureData({ data: new Uint8Array([1]), format: 'pdb' }), true)
  assert.equal(isStructureData({ data: new Uint8Array([1]), format: 'nope' }), false)
  assert.equal(isStructureData({ data: 'ATOM', format: 'pdb' }), true)
  assert.equal(isStructureData({ data: 42, format: 'pdb' }), false)
  assert.equal(isStructureData(null), false)

  const error = new Mol4AgentError('INVALID_COMMAND', 'bad command')
  assert.equal(error.code, 'INVALID_COMMAND')
  assert.equal(error.message, 'bad command')
})
