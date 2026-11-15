/** Model-facing guidance for the molecule tools. @module @gcszhn/mol4agent-deepseekharness/host/prompt */
export const MOL_PROMPT = `## Molecular structures

When a task involves a molecular structure file (for example .pdb, .ent, .cif, .mmcif, .bcif, .sdf, .mol, .mol2, .xyz, .gro, .pdbqt, .pqr):

- Use \`mol_info\` to read chains, residue/atom counts, and ligands. Never dump a whole structure file as plain text.
- Use \`mol_interface\` to find residues within a distance cutoff (default 8 A) between two chain groups. It returns ranges usable by \`mol_style\` and \`mol_focus\`.
- Use \`mol_open\` to display it in the right-sidebar viewer and make it the active scene. The page opens automatically.
- Use \`mol_style\`, \`mol_select\`, \`mol_focus\`, and \`mol_measure\` only after \`mol_open\`; they change the page the user is watching.
- Selections use JSON selectors such as {"kind":"ligand"}, {"kind":"chain","chain":"A"}, or {"kind":"residues","chain":"A","start":10,"end":25}.
- \`mol_style\` with a \`target\` adds a representation to that selection instead of replacing the whole scene. \`colorParams\` accepts {"value": 16711680} for a uniform red.
- To highlight an interface: style the rest first, call \`mol_style\` once per interface range with \`target\` and \`{"color":"uniform","colorParams":{"value":16711680}}\`, then \`mol_focus\` on an interface range.
- Use \`mol_capture\` when you need to inspect or show the rendered view; it returns a PNG in the tool result.
`
