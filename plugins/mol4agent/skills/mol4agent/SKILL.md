---
name: mol4agent
description: Open and operate 3D molecular structures in the mol4agent viewer, including multi-structure scenes, alignment, live inspection, TM-score, styling, and screenshots. Use when the user asks to inspect, compare, align, visualize, style, highlight, focus, measure, or screenshot a PDB, mmCIF, SDF, MOL2, XYZ, or GRO file, including interfaces, ligands, and binding sites.
---

# mol4agent

Use the `mol4agent` MCP tools for molecular structures. Do not read a whole
structure file as plain text, and do not drive the viewer with shell commands.

## Workflow

1. If the user names a database entry instead of a local file, `mol_fetch`
   downloads it: PDB ids (`1crn`), AlphaFold UniProt accessions (`P00533`),
   PubChem CIDs/names (`2244`, `aspirin`), or ChEMBL ids (`CHEMBL25`). Pass
   `source_db` when it is not a plain PDB entry, and use the returned path with
   `mol_open`.
2. `mol_info` first when you need chain ids, residue numbers, ligands, or atom
   counts. It does not open a page.
3. `mol_open` **once per structure** with the path to show it. The viewer
   appears as an MCP App card in the conversation, and the tool returns a
   compact summary instead of the file. Do not call `mol_open` again for the
   same path just to change the view: it replaces the active scene and resets
   the camera. Reuse the open scene with the tools below.
4. Operate the open scene:
   - `mol_style` for representation/color. It replaces the current
     representations by default; pass `replace: false` to overlay. `target`
     only narrows the part the new representation covers.
   - `mol_select` to select/highlight; `mol_focus` to frame it.
   - `mol_measure` for distance/angle/dihedral.
   - `mol_inspect` to read what the live viewer shows: per-component counts,
     residue/atom rows and coordinates, representation styles, base colour, and
     the visible colour after selection/overpaint overlays. It also accepts
     `{"kind":"selection"}` and `{"kind":"focus"}`.
   - `colorParams.value` only applies to `uniform`; it accepts a CSS name
     (`red`), hex (`#ff0000`), or an integer (`16711680`). Invalid colours are
     rejected and the result echoes the resolved hex.
5. For comparisons, `mol_add_structure` appends another structure to the same
   scene under a stable id. Use `mol_list_structures` to see ids, add
   `structureId` to selectors when chain ids collide, and run `mol_align`
   (moves the target) or `mol_tmscore` (read-only scoring).
6. `mol_capture` to return a PNG from the existing viewer tab. It does not
   mount another card; the tab must still be open.

## Selectors

```json
{ "kind": "ligand" }
{ "kind": "protein" }
{ "kind": "chain", "chain": "A" }
{ "kind": "residues", "chain": "A", "start": 10, "end": 25 }
{ "kind": "residue", "chain": "A", "index": 42 }
{ "kind": "comp", "compId": "ATP" }
```

Add `structureId` for a multi-structure scene:

```json
{ "kind": "chain", "chain": "A", "structureId": "pdl1" }
```

## Examples

```json
{ "name": "mol_fetch", "arguments": {
  "entry_id": "1crn",
  "target_path": "fixtures/1crn.pdb"
} }
```

```json
{ "name": "mol_fetch", "arguments": {
  "entry_id": "P00533",
  "source_db": "alphafold",
  "target_path": "egfr.pdb"
} }
```

```json
{ "name": "mol_open", "arguments": {
  "path": "fixtures/1atp.pdb",
  "type": "cartoon",
  "color": "chain-id",
  "select": { "kind": "ligand" },
  "focus": true
} }
```

```json
{ "name": "mol_interface", "arguments": {
  "path": "fixtures/7czd.pdb",
  "chainsA": ["A"],
  "chainsB": ["B"],
  "cutoff": 8
} }
```

Align two PD-L1 structures:

```json
{ "name": "mol_add_structure", "arguments": {
  "path": "fixtures/4zqk.pdb",
  "id": "pdl1"
} }
```

```json
{ "name": "mol_align", "arguments": {
  "reference": "structure",
  "target": "pdl1",
  "method": "tm-align",
  "referenceChain": "A",
  "targetChain": "A"
} }
```

```json
{ "name": "mol_tmscore", "arguments": {
  "reference": { "kind": "chain", "chain": "A", "structureId": "structure" },
  "target": { "kind": "chain", "chain": "A", "structureId": "pdl1" }
} }
```

Then style each returned range:

```json
{ "name": "mol_style", "arguments": {
  "type": "ball-and-stick",
  "color": "uniform",
  "colorParams": { "value": "red" },
  "target": { "kind": "residues", "chain": "A", "start": 28, "end": 54 },
  "replace": false
} }
```

## Notes

- Paths may be absolute or relative to the workspace.
- `mol_fetch` saves uncompressed files, so the target suffix must match the
  source format (`.pdb`, `.cif`, `.bcif`, or `.sdf`); a `.gz` target is
  rejected. A directory target uses the source file name.
- One scene is active at a time, but it can hold several structures added with
  `mol_add_structure`. Adjust it with `mol_style` / `mol_select` /
  `mol_focus` / `mol_measure` / `mol_inspect` / `mol_align` / `mol_tmscore` /
  `mol_capture`. Calling `mol_open` again restarts the scene instead of applying
  an adjustment.
- `mol_align` moves the target structure and keeps the reference fixed.
  `mol_tmscore` moves nothing and works on arbitrary selections.
- `mol_inspect` and both alignment tools read the live page, so keep the viewer
  tab open.
- BCIF renders but cannot be summarized by `mol_info` yet.
- `mol_interface` supports PDB-like ATOM files only.
- If `mol_capture` times out, keep the viewer tab open and retry; reopen the
  structure only if the tab was closed.
