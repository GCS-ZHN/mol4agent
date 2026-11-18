/**
 * Model-facing text for one inspection result.
 *
 * Kept free of OpenCode, Mol*, and DOM imports so the layout is unit testable
 * without a running app or a viewer. It mirrors the DSH formatter: totals, the
 * complete per-component counts, optional rows, the representations drawing
 * the target, and the effective appearance after selection/overpaint layers.
 *
 * @module @gcszhn/mol4agent-opencode/format-inspect
 */
import type {
  InspectAppearance,
  InspectOverlay,
  InspectResidue,
  InspectSelection,
  InspectStyle,
  InspectResult,
} from '@gcszhn/mol4agent-core/protocol'

/** One line per aggregate component id. */
function countLine(compId: string, kind: string, residues: number, atoms: number): string {
  return `- ${compId} (${kind}): ${residues} residue${residues === 1 ? '' : 's'}, `
    + `${atoms} atom${atoms === 1 ? '' : 's'}`
}

/** Position triple as printed in residue and atom rows. */
function position(x: number, y: number, z: number): string {
  return `${x} ${y} ${z}`
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function selectionLine(label: string, selection: InspectSelection): string {
  const entries = `${selection.entries} ${selection.entries === 1 ? 'entry' : 'entries'}`
  const head = `${label}: ${entries}, `
    + `${plural(selection.residues, 'residue')}, ${plural(selection.atoms, 'atom')}`
  const groups = selection.groups
  if (groups === undefined || groups.length <= 1) return head
  const sizes = groups.map(group => `${plural(group.residues, 'residue')}/${plural(group.atoms, 'atom')}`)
  return `${head} (entries: ${sizes.join(', ')})`
}

function overlayLine(overlay: InspectOverlay): string {
  const parts: string[] = [overlay.source]
  if (overlay.color !== undefined) parts.push(overlay.color)
  if (overlay.strength !== undefined) parts.push(`strength ${overlay.strength}`)
  if (overlay.label !== undefined) parts.push(`on ${overlay.label}`)
  if (overlay.hidden === true) parts.push('not tinting the body colour')
  return `- ${parts.join(' ')}`
}

/** `base #x` plus `visible #y` when overlays change what is drawn. */
function colorPair(baseColor: string | undefined, visibleColor: string | undefined): string {
  if (baseColor === undefined && visibleColor === undefined) return ''
  if (baseColor === undefined) return ` visible ${visibleColor}`
  if (visibleColor === undefined || visibleColor === baseColor) return ` base ${baseColor}`
  return ` base ${baseColor} -> visible ${visibleColor}`
}

function appearanceLines(appearance: InspectAppearance): string[] {
  const lines = [`appearance:${colorPair(appearance.baseColor, appearance.visibleColor)}`]
  if (appearance.overlays.length === 0) return lines
  lines.push('overlays:')
  for (const overlay of appearance.overlays) lines.push(overlayLine(overlay))
  return lines
}

function styleLine(style: InspectStyle): string {
  return `- ${style.component}: ${style.type} / ${style.color} / ${style.size}`
    + `${colorPair(style.baseColor, style.visibleColor)}`
    + `${style.hidden === true ? ' (hidden)' : ''}`
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
  lines.push(
    `atoms: ${result.atoms}, residues: ${result.residues}, `
    + `chains: ${result.chains}, models: ${result.models}`,
  )
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

  if (result.appearance !== undefined) lines.push(...appearanceLines(result.appearance))

  if (result.truncated) {
    lines.push('note: rows are truncated; totals above cover the whole target. Raise limit to list more.')
  }
  lines.push('</inspect>')
  return lines.join('\n')
}
