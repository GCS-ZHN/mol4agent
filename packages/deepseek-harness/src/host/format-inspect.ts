/**
 * Model-facing text for one inspection result.
 *
 * Kept separate from the tool so the layout can be unit tested without a
 * browser or a Mol* viewer.
 *
 * @module @gcszhn/mol4agent-deepseekharness/host/format-inspect
 */
import type { InspectResidue, InspectSelection, InspectStyle, InspectResult } from '@gcszhn/mol4agent-core/protocol'

/** One line per aggregate component id. */
function countLine(compId: string, kind: string, residues: number, atoms: number): string {
  return `- ${compId} (${kind}): ${residues} residue${residues === 1 ? '' : 's'}, ${atoms} atom${atoms === 1 ? '' : 's'}`
}

/** Position triple as printed in residue and atom rows. */
function position(x: number, y: number, z: number): string {
  return `${x} ${y} ${z}`
}

function selectionLine(label: string, selection: InspectSelection): string {
  return `${label}: ${selection.entries} ${selection.entries === 1 ? 'entry' : 'entries'}, `
    + `${selection.residues} residues, ${selection.atoms} atoms`
}

function styleLine(style: InspectStyle): string {
  const color = style.colorValue === undefined ? style.color : `${style.color} ${style.colorValue}`
  return `- ${style.component}: ${style.type} / ${color} / ${style.size}${style.hidden === true ? ' (hidden)' : ''}`
}

function atomLine(residue: InspectResidue, index: number): string {
  const atom = residue.atomRows?.[index]
  if (atom === undefined) return ''
  const occupancy = atom.occupancy === undefined || atom.occupancy === 1 ? '' : ` occ ${atom.occupancy}`
  const bFactor = atom.bFactor === undefined ? '' : ` b ${atom.bFactor}`
  const alt = atom.altId === undefined ? '' : ` alt ${atom.altId}`
  return `  - ${atom.name} ${atom.element} ${position(atom.x, atom.y, atom.z)}${occupancy}${bFactor}${alt}`
}

function residueLine(residue: InspectResidue): string {
  return `- ${residue.chain}${residue.seqId} ${residue.compId} (${residue.kind}): `
    + `${residue.atoms} atom${residue.atoms === 1 ? '' : 's'}, center ${position(residue.x, residue.y, residue.z)}`
}

/**
 * Render one inspection result.
 *
 * The header repeats the target and detail so a later answer is still
 * self-describing when the conversation scrolls, and the trailing note tells
 * the model whether the rows it sees are complete.
 */
export function formatInspectResult(result: InspectResult): string {
  const lines: string[] = [`<inspect target="${result.target}" detail="${result.detail}">`]
  lines.push(`atoms: ${result.atoms}, residues: ${result.residues}, chains: ${result.chains}, models: ${result.models}`)
  if (result.selection !== undefined) lines.push(selectionLine('selection', result.selection))
  if (result.focus !== undefined) lines.push(selectionLine('focus', result.focus))

  lines.push('counts:')
  if (result.counts.length === 0) lines.push('- none')
  for (const count of result.counts) {
    lines.push(countLine(count.compId, count.kind, count.residues, count.atoms))
  }

  if (result.residueRows !== undefined) {
    if (result.residueRows.length === 0) {
      lines.push('no residues matched this target')
    } else {
      lines.push(result.detail === 'atoms' ? 'residues and atoms:' : 'residues:')
      for (const residue of result.residueRows) {
        lines.push(residueLine(residue))
        if (residue.atomRows === undefined) continue
        for (let index = 0; index < residue.atomRows.length; index += 1) lines.push(atomLine(residue, index))
      }
    }
  }

  if (result.styles.length > 0) {
    lines.push('styles:')
    for (const style of result.styles) lines.push(styleLine(style))
  }

  if (result.truncated) {
    lines.push('note: rows are truncated; totals above cover the whole target. Raise limit to list more.')
  }
  lines.push('</inspect>')
  return lines.join('\n')
}
