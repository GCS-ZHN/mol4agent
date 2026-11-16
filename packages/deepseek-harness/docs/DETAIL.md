# Molecular structure preview

For the full tool/API reference, see [../README.md](../README.md).

Open a molecular structure file in the right-sidebar previewer and it renders
in 3D instead of plain text. The agent can then operate the same page through
`mol_*` tools while you watch.

## Manual open

The document previewer lists this viewer as **Structure** for:

`pdb`, `ent`, `pdbqt`, `pqr`, `cif`, `mmcif`, `mcif`, `bcif`, `mol`, `sdf`, `sd`,
`mol2`, `xyz`, `gro`, and every one of those with a `.gz` suffix (for example
`pdb.gz`, `cif.gz`, `sdf.gz`).

It is the default choice for those suffixes. Gzip is decoded by the adapter
before core receives bytes; the decompressed size is capped. The previewer's
**Open with** menu still lists **Code** and **Plain text**, so you can switch
back at any time; `bcif` has no plain-text fallback because its bytes are binary.

The viewer mounts Mol*'s own React UI: viewport controls (reset, screenshot,
settings, selection, fullscreen). The official control-panel set (right
**Structure Tools**, left State Tree/Home, top sequence) **starts closed**
(`showControls: false`); the viewport's sliders button toggles it open. Mol*
renders these regions only while `showControls` is true.

Light/dark follows the DSH theme: the Mol* skin and canvas background switch on
`theme/change`. Switching document tabs parks the live Mol* container and
reattaches it, so camera, representations, and panel state survive a switch
(two most recent tabs are kept; closing the plugin disposes them).

## Agent operation

| Tool | Effect |
|---|---|
| `mol_info` | Reads chains, residues, atoms, and ligands without opening a page |
| `mol_interface` | Finds residues within a cutoff between two chain groups (PDB-like files) |
| `mol_fetch` | Downloads a database entry (RCSB PDB, AlphaFold, PubChem, ChEMBL) to a workspace path |
| `mol_open` | Opens the structure in a tab page (id = absolute path) and makes it active |
| `mol_style` | Replaces the representation/theme, or adds one to a `target` selection |
| `mol_select` | Selects or highlights a chain/residue/ligand/water/ion |
| `mol_focus` | Moves the camera to a selection (or the whole structure) |
| `mol_measure` | Adds a distance, angle, or dihedral between selections |
| `mol_capture` | Returns a PNG of the target tab viewport in the tool result |

`mol_style`, `mol_select`, `mol_focus`, `mol_measure`, and `mol_capture` accept
`tab` (the path returned by `mol_open`) and default to the active tab. `mol_open`, `mol_style`, `mol_select`, `mol_focus`, and
`mol_measure` write the durable per-tab scene to the Session projection; each
open viewer follows only its own tab; a reopened Session can restore the last
tab scenes. `mol_capture` blocks until the open page delivers
the image through the internal `mol4agent_capture` session command.

Selections are JSON, for example:

```json
{"kind":"ligand"}
{"kind":"chain","chain":"A"}
{"kind":"residues","chain":"A","start":10,"end":25}
{"kind":"comp","compId":"ATP"}
```

## Current limitations

- The structure summary is computed on the Host from bytes; binary CIF (`bcif`)
  can be rendered but has no summary yet.
- `mol_style` without `target` applies one global representation; with `target`
  it adds a selection component (e.g. red sticks on an interface).
- `mol_interface` currently handles PDB-like ATOM files only.
- Files larger than 64 MiB are refused.
- WebGL 2 is required; a machine without a usable GPU shows a load error.
- Screenshot delivery appears as a short `mol4agent_capture` command row in the
  conversation.
