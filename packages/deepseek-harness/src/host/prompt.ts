/** Model-facing guidance for the molecule tools. @module @gcszhn/mol4agent-deepseekharness/host/prompt */
export const MOL_PROMPT = `## Molecular structures

When a task involves a molecular structure file (for example .pdb, .ent, .cif, .mmcif, .bcif, .sdf, .mol, .mol2, .xyz, .gro, .pdbqt, .pqr):

- Use \`mol_info\` to read chains, residue/atom counts, and ligands. Never dump a whole structure file as plain text.
- Use \`mol_fetch\` when the user names a database entry instead of a local file: it downloads from RCSB PDB (\`rcsb-pdb\`, \`rcsb-cif\`, \`rcsb-bcif\`), AlphaFold DB, PubChem, or ChEMBL to \`target_path\`, then returns the saved path and a summary. Pass \`source_db\` (default \`rcsb-pdb\`); call \`mol_open\` on the returned path to display it.
- Use \`mol_interface\` to find residues within a distance cutoff (default 8 A) between two chain groups. It returns one compact range per chain, usable by \`mol_style\` and \`mol_focus\`.
- Use \`mol_open\` to display it in a right-sidebar tab page and make it the active tab. The page opens automatically; the result includes the tab page id (a \`/\`-separated absolute path).
- \`mol_style\`, \`mol_select\`, \`mol_focus\`, \`mol_measure\`, and \`mol_capture\` accept a \`tab\` argument. Omit it to use the active tab; pass the id returned by \`mol_open\` to operate another tab independently. Either path separator addresses the same page.
- Selections use JSON selectors such as {"kind":"ligand"}, {"kind":"chain","chain":"A"}, or {"kind":"residues","chain":"A","range":"10-25, 40"}.
- A \`residues\` \`range\` takes comma-separated inclusive numeric segments (\`12\`, \`5-10\`) of the residue id: \`auth_seq_id\` by default, or \`label_seq_id\` with \`auth:false\`. It is residue-level, not a sequence position: \`1\` selects the residue numbered 1 (all its atoms), and insertion codes sharing that number are all selected.
- \`mol_style\` with a \`target\` adds a representation to that selection instead of replacing the whole scene. \`colorParams.value\` only applies to \`uniform\` and accepts a CSS name ("red"), hex ("#ff0000"), or an integer (16711680); invalid colours are rejected and the result echoes the resolved hex.
- To highlight an interface: style the rest first, then call \`mol_style\` once per interface chain with \`target\` and \`{"color":"uniform","colorParams":{"value":16711680}}\`, then \`mol_focus\` on a chain range.
- Use \`mol_capture\` when you need to inspect or show the rendered view; it returns a PNG in the tool result. Capture targets the tab page in \`tab\` (or the active tab) and activates that tab.
`
