/**
 * PDB-like interface residue discovery (copied from the ChatGPT adapter). The
 * result is a list/ranges the selector protocol can express, so coordinates
 * never leave the server.
 *
 * @module @gcszhn/mol4agent-opencode/interface
 */

export interface InterfaceResidue {
  readonly chain: string
  readonly index: number
  readonly compId: string
}

export interface InterfaceRange {
  readonly chain: string
  readonly start: number
  readonly end: number
}

export interface InterfaceResult {
  readonly cutoff: number
  readonly residues: readonly InterfaceResidue[]
  readonly ranges: readonly InterfaceRange[]
  readonly contactPairs: number
}

interface Atom {
  readonly x: number
  readonly y: number
  readonly z: number
}

interface Residue {
  readonly chain: string
  readonly index: number
  readonly insertionCode: string
  readonly compId: string
  readonly atoms: Atom[]
}

/** Find residues of `chainsA` within `cutoff` Å of residues of `chainsB`. */
export function findInterfaceResidues(
  bytes: Uint8Array,
  options: { readonly chainsA: readonly string[]; readonly chainsB: readonly string[]; readonly cutoff: number },
): InterfaceResult {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  const chainsA = new Set(options.chainsA.map(chain => chain.trim()).filter(Boolean))
  const chainsB = new Set(options.chainsB.map(chain => chain.trim()).filter(Boolean))
  const cutoffSquared = options.cutoff * options.cutoff
  const residues = new Map<string, Residue>()

  for (const line of text.split(/\r?\n/u)) {
    if (!line.startsWith('ATOM  ')) continue
    const chain = line[21] ?? ''
    if (!chainsA.has(chain) && !chainsB.has(chain)) continue
    const element = (line.slice(76, 78).trim() || line.slice(12, 16).trim().slice(0, 1)).toUpperCase()
    if (element === 'H' || element === 'D') continue
    const index = Number.parseInt(line.slice(22, 26).trim(), 10)
    if (!Number.isFinite(index)) continue
    const x = Number.parseFloat(line.slice(30, 38))
    const y = Number.parseFloat(line.slice(38, 46))
    const z = Number.parseFloat(line.slice(46, 54))
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
    const insertionCode = (line[26] ?? ' ').trim()
    const compId = line.slice(17, 20).trim()
    const key = `${chain}:${index}:${insertionCode}`
    let residue = residues.get(key)
    if (residue === undefined) {
      residue = { chain, index, insertionCode, compId, atoms: [] }
      residues.set(key, residue)
    }
    residue.atoms.push({ x, y, z })
  }

  const listA = [...residues.values()].filter(residue => chainsA.has(residue.chain))
  const listB = [...residues.values()].filter(residue => chainsB.has(residue.chain))
  const interfaceKeys = new Set<string>()
  let contactPairs = 0
  for (const a of listA) {
    for (const b of listB) {
      if (minimumDistanceSquared(a, b) > cutoffSquared) continue
      contactPairs += 1
      interfaceKeys.add(`${a.chain}:${a.index}:${a.insertionCode}`)
      interfaceKeys.add(`${b.chain}:${b.index}:${b.insertionCode}`)
    }
  }

  const interfaceResidues = [...residues.values()]
    .filter(residue => interfaceKeys.has(`${residue.chain}:${residue.index}:${residue.insertionCode}`))
    .sort((a, b) => a.chain.localeCompare(b.chain) || a.index - b.index)
    .map(residue => ({ chain: residue.chain, index: residue.index, compId: residue.compId }))

  return {
    cutoff: options.cutoff,
    residues: interfaceResidues,
    ranges: mergeRanges(interfaceResidues),
    contactPairs,
  }
}

function minimumDistanceSquared(a: Residue, b: Residue): number {
  let minimum = Number.POSITIVE_INFINITY
  for (const left of a.atoms) {
    for (const right of b.atoms) {
      const dx = left.x - right.x
      const dy = left.y - right.y
      const dz = left.z - right.z
      const distance = dx * dx + dy * dy + dz * dz
      if (distance < minimum) {
        minimum = distance
        if (minimum === 0) return 0
      }
    }
  }
  return minimum
}

function mergeRanges(residues: readonly InterfaceResidue[]): InterfaceRange[] {
  const ranges: InterfaceRange[] = []
  for (const residue of residues) {
    const last = ranges.at(-1)
    if (last !== undefined && last.chain === residue.chain && last.end + 1 === residue.index) {
      ranges[ranges.length - 1] = { chain: last.chain, start: last.start, end: residue.index }
    } else {
      ranges.push({ chain: residue.chain, start: residue.index, end: residue.index })
    }
  }
  return ranges
}
