---
name: mol4agent
description: Open and operate a 3D molecular structure in the mol4agent viewer. Use when the user asks to inspect, visualize, style, highlight, focus, measure, or screenshot a PDB, mmCIF, SDF, MOL2, XYZ, or GRO file, including interfaces, ligands, and binding sites.
---

# mol4agent

Use the `mol4agent` MCP tools for molecular structures. Do not read a whole
structure file as plain text, and do not drive the viewer with shell commands.

## Workflow

1. `mol_info` first when you need chain ids, residue numbers, ligands, or atom
   counts. It does not open a page.
2. `mol_open` with the path to show the structure. The viewer appears as an MCP
   App card in the conversation. The tool returns a compact summary, not the
   file.
3. Operate the open scene:
   - `mol_style` for representation/color; add `target` for a selection only.
   - `mol_select` to select/highlight; `mol_focus` to frame it.
   - `mol_measure` for distance/angle/dihedral.
4. `mol_capture` to return a PNG. The viewer card must still be mounted.

## Selectors

```json
{ "kind": "ligand" }
{ "kind": "protein" }
{ "kind": "chain", "chain": "A" }
{ "kind": "residues", "chain": "A", "start": 10, "end": 25 }
{ "kind": "residue", "chain": "A", "index": 42 }
{ "kind": "comp", "compId": "ATP" }
```

## Examples

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

Then style each returned range:

```json
{ "name": "mol_style", "arguments": {
  "type": "ball-and-stick",
  "color": "uniform",
  "colorParams": { "value": 16711680 },
  "target": { "kind": "residues", "chain": "A", "start": 28, "end": 54 }
} }
```

## Notes

- Paths may be absolute or relative to the workspace.
- One scene is active at a time; `mol_open` replaces it.
- BCIF renders but cannot be summarized by `mol_info` yet.
- `mol_interface` supports PDB-like ATOM files only.
- If `mol_capture` times out, keep the viewer card open and retry.
