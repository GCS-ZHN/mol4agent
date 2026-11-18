/** Model-facing guidance for the molecule tools. @module @gcszhn/mol4agent-deepseekharness/host/prompt */
export const MOL_PROMPT = `## Molecular structures

When a task involves a molecular structure file (for example .pdb, .ent, .cif, .mmcif, .bcif, .sdf, .mol, .mol2, .xyz, .gro, .pdbqt, .pqr):

- Use \`mol_info\` to read chains, residue/atom counts, and ligands. Never dump a whole structure file as plain text.
- Use \`mol_inspect\` to read what the viewer currently shows instead of parsing the file yourself: residue/atom identity and coordinates, per-component counts (the default summary answers "how many waters", "how many Cys"), residue rows (\`detail: "residues"\`) and per-atom rows (\`detail: "atoms"\`), plus the representations, colour themes, size themes, and both the theme colour (\`baseColor\`) and the colour actually visible (\`visibleColor\`) after overpaint and the selection marker. It reads live Mol* state, so it also sees what a human clicked or styled; \`target: {"kind":"selection"}\` describes the current selection entry by entry and \`{"kind":"focus"}\` the last clicked location. It reads the open page, so call \`mol_open\` first when the structure is not displayed yet.
- Use \`mol_fetch\` when the user names a database entry instead of a local file: it downloads from RCSB PDB (\`rcsb-pdb\`, \`rcsb-cif\`, \`rcsb-bcif\`), AlphaFold DB, PubChem, or ChEMBL to \`target_path\`, then returns the saved path and a summary. Pass \`source_db\` (default \`rcsb-pdb\`); call \`mol_open\` on the returned path to display it.
- Use \`mol_interface\` to find residues within a distance cutoff (default 8 A) between two chain groups. It returns ranges usable by \`mol_style\` and \`mol_focus\`.
- Use \`mol_open\` to display it in a right-sidebar tab page and make it the active tab. The page opens automatically; the result includes the tab page id (a \`/\`-separated absolute path).
- \`mol_style\`, \`mol_select\`, \`mol_focus\`, \`mol_measure\`, \`mol_inspect\`, and \`mol_capture\` accept a \`tab\` argument. Omit it to use the active tab; pass the id returned by \`mol_open\` to operate another tab independently. Either path separator addresses the same page.
- Selections use JSON selectors such as {"kind":"ligand"}, {"kind":"chain","chain":"A"}, or {"kind":"residues","chain":"A","start":10,"end":25}.
- \`mol_style\` with a \`target\` adds a representation to that selection instead of replacing the whole scene. \`colorParams.value\` only applies to \`uniform\` and accepts a CSS name ("red"), hex ("#ff0000"), or an integer (16711680); invalid colours are rejected and the result echoes the resolved hex.
- To highlight an interface: style the rest first, call \`mol_style\` once per interface range with \`target\` and \`{"color":"uniform","colorParams":{"value":16711680}}\`, then \`mol_focus\` on an interface range.
- Use \`mol_capture\` when you need to inspect or show the rendered view; it returns a PNG in the tool result. Capture targets the tab page in \`tab\` (or the active tab) and activates that tab.
`
