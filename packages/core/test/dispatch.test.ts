import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeStructure } from '../src/parse/index.ts'

const atom = 'ATOM      1  CA  ALA A   1       0.000   0.000   0.000  1.00  0.00           C'

test('summarizeStructure dispatches every supported text format', () => {
  const cases: readonly [string, string][] = [
    ['pdb', `${atom}\n`],
    ['pdbqt', `${atom}\n`],
    ['pqr', `${atom}\n`],
    ['mmcif', 'data_x\nloop_\n_atom_site.group_PDB\n_atom_site.label_comp_id\n_atom_site.auth_asym_id\n_atom_site.auth_seq_id\nATOM ALA A 1\n#\n'],
    ['mol', 'mol\n  1  0  0  0  0  0            999 V2000\n'],
    ['sdf', 'sdf\n  1  0  0  0  0  0            999 V2000\n$$$$\n'],
    ['mol2', '@<TRIPOS>MOLECULE\nx\n@<TRIPOS>ATOM\n1 C1 0 0 0 C.ar 1 LIG 0\n'],
    ['xyz', '1\nx\nC 0 0 0\n'],
    ['gro', 'x\n    1\n    1ALA     1   0.000   0.000   0.000\n   1.000   1.000   1.000\n'],
  ]
  for (const [format, text] of cases) {
    const summary = summarizeStructure({ data: text, format: format as never, label: `x.${format}` })
    assert.equal(summary.format, format, format)
    assert.equal(summary.complete, true, format)
    assert.ok(summary.atomCount > 0, format)
  }
})

test('accepts bytes, strings, and CRLF line endings', () => {
  const stringSummary = summarizeStructure({ data: `${atom}\r\n${atom}\r\n`, format: 'pdb' })
  const byteSummary = summarizeStructure({ data: new TextEncoder().encode(`${atom}\r\n${atom}\r\n`), format: 'pdb' })
  assert.deepEqual(byteSummary, stringSummary)
  assert.equal(stringSummary.atomCount, 2)
  assert.equal(stringSummary.residueCount, 1)
})
