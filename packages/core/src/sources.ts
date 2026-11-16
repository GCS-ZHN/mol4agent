/**
 * Online structure sources for `mol_fetch`.
 *
 * Core decides what an entry id means and where its bytes live. It never
 * downloads anything: network access, filesystem writes, authorization, and
 * session state belong to the adapter, which executes the returned plan.
 *
 * @module @gcszhn/mol4agent-core/sources
 */
import { Mol4AgentError, type MolFormat } from './protocol.ts'

/** Databases `mol_fetch` can download from. The first is the default. */
export const SOURCE_DATABASES = [
  'rcsb-pdb',
  'rcsb-cif',
  'rcsb-bcif',
  'alphafold',
  'pubchem',
  'chembl',
] as const

export type SourceDatabase = (typeof SOURCE_DATABASES)[number]

/** Stable, model-facing facts about one source database. */
export interface SourceDatabaseInfo {
  readonly label: string
  readonly description: string
  /** What `entry_id` must contain for this source. */
  readonly entryHint: string
  readonly format: MolFormat
}

export const SOURCE_DATABASE_INFO: Readonly<Record<SourceDatabase, SourceDatabaseInfo>> = {
  'rcsb-pdb': {
    label: 'RCSB PDB',
    description: 'Experimental structure from the RCSB Protein Data Bank, in PDB format.',
    entryHint: '4-character PDB entry id, e.g. 1crn',
    format: 'pdb',
  },
  'rcsb-cif': {
    label: 'RCSB PDB (mmCIF)',
    description: 'Experimental structure from the RCSB Protein Data Bank, in mmCIF format.',
    entryHint: '4-character PDB entry id, e.g. 1crn',
    format: 'mmcif',
  },
  'rcsb-bcif': {
    label: 'RCSB PDB (BinaryCIF)',
    description: 'Experimental structure from the RCSB model server, in BinaryCIF format.',
    entryHint: '4-character PDB entry id, e.g. 1crn',
    format: 'bcif',
  },
  alphafold: {
    label: 'AlphaFold DB',
    description: 'Predicted protein structure from AlphaFold DB, in PDB format.',
    entryHint: 'UniProt accession, e.g. P00533',
    format: 'pdb',
  },
  pubchem: {
    label: 'PubChem',
    description: 'Small-molecule compound from PubChem, in 3D SDF format.',
    entryHint: 'PubChem CID (2244) or compound name (aspirin)',
    format: 'sdf',
  },
  chembl: {
    label: 'ChEMBL',
    description: 'Small-molecule compound from ChEMBL, in SDF format.',
    entryHint: 'ChEMBL id, e.g. CHEMBL25 (a bare number gets the CHEMBL prefix)',
    format: 'sdf',
  },
}

/**
 * How an adapter obtains the bytes.
 *
 * `url` is either the file itself or, when `indexField` is set, a JSON index
 * document. In the latter case the adapter reads `indexField` (a dot path such
 * as `0.pdbUrl`) from that document and downloads the URL it names.
 */
export interface SourceFetchPlan {
  readonly url: string
  readonly indexField?: string
}

/** One `mol_fetch` request, before the adapter touches the network. */
export interface SourceRequest {
  readonly entryId: string
  /** Defaults to `rcsb-pdb`. */
  readonly sourceDb?: SourceDatabase
}

/** A validated download plan. */
export interface ResolvedSource {
  readonly sourceDb: SourceDatabase
  /** Normalized entry id, e.g. `1CRN`, `P00533`, or `CHEMBL25`. */
  readonly entryId: string
  readonly format: MolFormat
  /** Suggested file name when `target_path` names a directory. */
  readonly fileName: string
  readonly plan: SourceFetchPlan
  /** One-line, model-facing description, e.g. `RCSB PDB entry 1CRN (PDB format)`. */
  readonly description: string
}

/** Normalize an agent-supplied source name; `undefined` selects `rcsb-pdb`. */
export function normalizeSourceDb(value: string | undefined): SourceDatabase {
  if (value === undefined) return 'rcsb-pdb'
  const normalized = value.trim().toLowerCase()
  if (normalized === '') return 'rcsb-pdb'
  if (isSourceDatabase(normalized)) return normalized
  throw new Mol4AgentError(
    'UNSUPPORTED_SOURCE',
    `unknown source_db "${value}"; supported: ${SOURCE_DATABASES.join(', ')}`,
  )
}

/** Validate an entry id and build the adapter's fetch plan. */
export function resolveSource(request: SourceRequest): ResolvedSource {
  const sourceDb = normalizeSourceDb(request.sourceDb)
  const info = SOURCE_DATABASE_INFO[sourceDb]
  if (typeof request.entryId !== 'string' || request.entryId.trim() === '') {
    throw new Mol4AgentError('INVALID_ENTRY_ID', `entry_id is required for ${sourceDb} (${info.entryHint})`)
  }
  const entry = request.entryId.trim()

  switch (sourceDb) {
    case 'rcsb-pdb': {
      const id = pdbEntryId(entry, sourceDb)
      return {
        sourceDb,
        entryId: id,
        format: 'pdb',
        fileName: `${id}.pdb`,
        plan: { url: `https://files.rcsb.org/download/${id}.pdb` },
        description: `RCSB PDB entry ${id} (PDB format)`,
      }
    }
    case 'rcsb-cif': {
      const id = pdbEntryId(entry, sourceDb)
      return {
        sourceDb,
        entryId: id,
        format: 'mmcif',
        fileName: `${id}.cif`,
        plan: { url: `https://files.rcsb.org/download/${id}.cif` },
        description: `RCSB PDB entry ${id} (mmCIF format)`,
      }
    }
    case 'rcsb-bcif': {
      const id = pdbEntryId(entry, sourceDb)
      return {
        sourceDb,
        entryId: id,
        format: 'bcif',
        fileName: `${id}.bcif`,
        plan: { url: `https://models.rcsb.org/${id}.bcif` },
        description: `RCSB PDB entry ${id} (BinaryCIF format)`,
      }
    }
    case 'alphafold': {
      const accession = uniprotAccession(entry)
      return {
        sourceDb,
        entryId: accession,
        format: 'pdb',
        fileName: `AF-${accession}-F1-model.pdb`,
        plan: {
          url: `https://alphafold.ebi.ac.uk/api/prediction/${accession}`,
          indexField: '0.pdbUrl',
        },
        description: `AlphaFold DB prediction for UniProt ${accession} (PDB format)`,
      }
    }
    case 'pubchem': {
      const compound = pubchemCompound(entry)
      return {
        sourceDb,
        entryId: compound.entryId,
        format: 'sdf',
        fileName: compound.fileName,
        plan: { url: compound.url },
        description: `PubChem compound ${compound.entryId} (3D SDF)`,
      }
    }
    case 'chembl': {
      const id = chemblId(entry)
      return {
        sourceDb,
        entryId: id,
        format: 'sdf',
        fileName: `${id}.sdf`,
        plan: { url: `https://www.ebi.ac.uk/chembl/api/data/molecule/${id}.sdf` },
        description: `ChEMBL molecule ${id} (SDF)`,
      }
    }
  }
}

/**
 * Read a dot path from a JSON index document (numeric segments index arrays).
 *
 * Used by adapters for sources whose file URL is versioned, such as AlphaFold.
 * Returns undefined when the path is missing or is not a string.
 */
export function readSourceIndexField(payload: unknown, field: string): string | undefined {
  let current: unknown = payload
  for (const segment of field.split('.')) {
    if (Array.isArray(current)) {
      const index = Number(segment)
      if (!Number.isInteger(index) || index < 0) return undefined
      current = current[index]
      continue
    }
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return typeof current === 'string' ? current : undefined
}

export function isSourceDatabase(value: unknown): value is SourceDatabase {
  return typeof value === 'string' && (SOURCE_DATABASES as readonly string[]).includes(value)
}

/** Every source database id, in display order. */
export function sourceDatabases(): readonly SourceDatabase[] {
  return SOURCE_DATABASES
}

const PDB_ENTRY_ID = /^[0-9][A-Z0-9]{3}$/u
const UNIPROT_ACCESSION = /^(?:[A-Z0-9]{6}|[A-Z0-9]{10})$/u
const CHEMBL_ID = /^CHEMBL[0-9]+$/u
const MAX_PUBCHEM_NAME = 120

function pdbEntryId(entry: string, sourceDb: SourceDatabase): string {
  const id = entry.toUpperCase()
  if (!PDB_ENTRY_ID.test(id)) {
    throw new Mol4AgentError(
      'INVALID_ENTRY_ID',
      `"${entry}" is not a PDB entry id for ${sourceDb}; expected 4 characters like 1crn`,
    )
  }
  return id
}

function uniprotAccession(entry: string): string {
  // Accept the AlphaFold file stem (`AF-P00533-F1`) as well as the bare accession.
  const stem = /^AF-([A-Z0-9]{6}|[A-Z0-9]{10})-F[0-9]+$/u.exec(entry.toUpperCase())
  const accession = stem?.[1] ?? entry.toUpperCase()
  if (!UNIPROT_ACCESSION.test(accession)) {
    throw new Mol4AgentError(
      'INVALID_ENTRY_ID',
      `"${entry}" is not a UniProt accession for alphafold; expected 6 or 10 characters like P00533`,
    )
  }
  return accession
}

function chemblId(entry: string): string {
  const value = entry.toUpperCase()
  const id = /^[0-9]+$/u.test(value) ? `CHEMBL${value}` : value
  if (!CHEMBL_ID.test(id)) {
    throw new Mol4AgentError(
      'INVALID_ENTRY_ID',
      `"${entry}" is not a ChEMBL id; expected CHEMBL25 or a numeric id like 25`,
    )
  }
  return id
}

function pubchemCompound(entry: string): { entryId: string; url: string; fileName: string } {
  const cid = /^(?:cid:?[ \t]*)?[0-9]+$/iu.test(entry)
  if (cid) {
    const id = entry.replace(/^cid:?[ \t]*/iu, '')
    return {
      entryId: id,
      url: `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${id}/SDF?record_type=3d`,
      fileName: `pubchem-${id}.sdf`,
    }
  }
  if (entry.length > MAX_PUBCHEM_NAME) {
    throw new Mol4AgentError(
      'INVALID_ENTRY_ID',
      `PubChem compound name is too long (${entry.length} characters; limit ${MAX_PUBCHEM_NAME})`,
    )
  }
  if (/[\u0000-\u001f\u007f]/u.test(entry)) {
    throw new Mol4AgentError('INVALID_ENTRY_ID', 'PubChem compound name contains control characters')
  }
  const slug = entry
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '')
  return {
    entryId: entry,
    url: `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(entry)}/SDF?record_type=3d`,
    fileName: `pubchem-${slug === '' ? 'compound' : slug.slice(0, 48)}.sdf`,
  }
}
