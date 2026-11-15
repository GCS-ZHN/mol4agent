# @gcszhn/mol4agent-opencode

OpenCode 2 adapter for [mol4agent](../../README.md): an in-harness Mol* 3D viewer
side panel that the agent operates with `mol_*` tools.

- **In-harness preview**: `mol_open` (agent) and the "Open molecular structure"
  command (human) render a structure in the side panel's official Mol* UI —
  no external app.
- **Agent-operated page**: `mol_style`, `mol_select`, `mol_focus`, `mol_measure`
  mutate the open page; `mol_info` and `mol_interface` summarize files without a
  viewer.
- **Screenshots**: `mol_capture` renders the viewport to a PNG saved under
  `.mol4agent/captures/`.
- **Same molecular semantics as DSH/ChatGPT**: this adapter passes the same
  `MolFormat`, selectors, commands, and capture semantics to
  `@gcszhn/mol4agent-core`.

## Architecture

The package is an OpenCode plugin with three parts:

- **server** (`exports["."]`, `src/server.ts`): registers the `mol_*` tools and
  the `mol4agent` RPC. It is the only place that sees paths, reads bytes, and
  stores the scene log.
- **GUI** (`exports["./gui-experimental"]`, `src/gui/`): a side `Panel` with one
  Mol* viewer tab per open structure, plus the launcher and pick-file command.
  It follows scenes through RPC and renders/delivers screenshots.
- **RPC** (`exports["./rpc"]`, `src/rpc.ts`): the typed `mol4agent` contract.

Core receives only `{ data, format, label }` plus JSON commands; paths, suffix
detection, IO, sessions, and UI all stay in this adapter.

## Tools

| Tool | Behavior |
|---|---|
| `mol_info` | Summarize chains, residues, atoms, ligands. Does not open a viewer. |
| `mol_interface` | Find interface residues between two chain groups (PDB-like ATOM files). |
| `mol_open` | Open a structure in the side panel and make it the active scene. |
| `mol_style` | Change representation/color; with `target`, style a selection additively. |
| `mol_select` | Select/highlight (and optionally focus) a selection. |
| `mol_focus` | Focus a selection or the whole structure. |
| `mol_measure` | Add a distance (2), angle (3), or dihedral (4) measurement. |
| `mol_capture` | Render the viewport to PNG and save under `.mol4agent/captures/`. |

Selectors are the same JSON shapes as the other adapters:

```json
{"kind":"ligand"}
{"kind":"chain","chain":"A"}
{"kind":"residues","chain":"A","start":10,"end":25}
{"kind":"residue","chain":"A","index":42}
{"kind":"comp","compId":"ATP"}
```

## Install (local)

Build core, then this package:

```sh
pnpm install
pnpm --filter @gcszhn/mol4agent-core build
pnpm --filter @gcszhn/mol4agent-opencode build
```

Add the package directory to the **global** `opencode.json(c)` so the desktop
app loads its GUI part in every window:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "/absolute/path/to/mol4agent/packages/opencode"
  ]
}
```

The server part loads for the current location; the GUI part loads in the
desktop app. GUI rebuilds reload in every window without a restart
(`pnpm --filter @gcszhn/mol4agent-opencode build`); server changes need a
`/reload`.

## Development

```sh
pnpm --filter @gcszhn/mol4agent-opencode typecheck
pnpm --filter @gcszhn/mol4agent-opencode build
```

`build` produces:

- `dist/index.js` — server part (ESM; core bundled, `@opencode/*`/`node:*` external).
- `dist/gui.cjs` — GUI part (one CommonJS file; core + Mol* + React bundled).
- `dist/rpc.js` — the RPC contract.

## Limitations

- OpenCode tool results have no inline-image content type, so `mol_capture`
  returns the saved path (and a `file` reference) rather than attaching the PNG
  to the model context.
- The file-tree `.pdb` click opens the built-in text editor; the structure
  preview is reached through `mol_open` or the pick-file command. A `FileViewer`
  interception is a follow-up.
- `mol_interface` parses PDB-like ATOM records only; `mol_info` cannot summarize
  BCIF from raw bytes yet.
- Files are capped at 64 MiB; WebGL 2 is required.
