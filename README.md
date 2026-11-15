# mol4agent

[English](README.md) | [中文](README_zh.md)

Turn molecular structure files in an agent harness from "a wall of plain text"
into a 3D page that humans can preview and agents can operate directly.

- **Human preview**: open a `.pdb` / `.cif` / `.sdf` / `.mol2` / `.xyz` / `.gro`
  file in the harness file previewer and get Mol*'s official 3D UI instead of
  text. The previewer's **Open with** menu still offers plain text/code.
- **Agent operation**: the LLM uses `mol_*` tools to change representations,
  colors, highlight residues/ligands, focus the camera, measure, and capture
  screenshots while the human watches the page change.
- **Agent-initiated open**: naming a file opens its structure preview
  automatically.
- **Cross-harness**: rendering and the command protocol live in
  `@gcszhn/mol4agent-core`; each harness gets a thin adapter package.

## Architecture

```mermaid
flowchart TB
  subgraph Harnesses["Agent harnesses"]
    DSH["@gcszhn/mol4agent-deepseekharness<br/>DSH adapter"]
    OA["@gcszhn/mol4agent-chatgpt<br/>ChatGPT/Codex adapter"]
  end

  subgraph Core["@gcszhn/mol4agent-core"]
    Proto["protocol + formats + selectors"]
    Viewer["Mol* official UI viewer"]
    Parse["byte-oriented summarizers"]
  end

  DSH -->|"path → bytes + MolFormat"| Proto
  OA -->|"path → bytes + MolFormat"| Proto
  Proto --> Viewer
  Proto --> Parse
  Viewer --> Capture["PNG capture"]
```

**Core boundary (the most important rule)**: core receives bytes plus an explicit
format only:

```ts
viewer.load({ data: bytes, format: 'pdb', label: '1crn.pdb' })
```

- DSH gets a path from its preview API and reads bytes with its own APIs;
- ChatGPT/Codex gets a path from `mol_*` tool calls and reads bytes in the MCP
  server; the MCP App receives only bytes plus format;
- suffix detection (`.pdb -> pdb`), authorization, filesystem access, sessions,
  and UI all live in the adapter;
- core contains no path logic and imports no harness package.

## Packages

| Package | Purpose | Status |
|---|---|---|
| [`@gcszhn/mol4agent-core`](packages/core) | Harness-neutral Mol* engine, command protocol, selectors, byte summaries, PNG capture | Implemented; verified with real 1CRN/1ATP/aspirin |
| [`@gcszhn/mol4agent-deepseekharness`](packages/deepseek-harness) | DSH adapter: right-sidebar document preview, session projection, `mol_*` tools, screenshot delivery | Implemented and installed in the Desktop profile |
| [`@gcszhn/mol4agent-chatgpt`](packages/chatgpt) | ChatGPT/Codex adapter: MCP App viewer, `mol_*` tools, long-poll scene updates, screenshot round trip | Implemented; local marketplace install, protocol tests, and a real MCP Apps smoke test |

## Quick start (DSH Desktop)

The plugin is installed in the current `desktop` profile:

1. Open `fixtures/1crn.pdb` (or `fixtures/1atp.pdb`, `fixtures/aspirin.sdf`,
   `fixtures/1crn.cif`) from the file tree.
   - The default renderer is **Structure preview**; the previewer's **Open with**
     menu can switch back to plain text/code.
2. Ask the agent:
   > Open fixtures/1atp.pdb, use cartoon representation and chain-id coloring,
   > highlight the ATP ligand, focus it, and capture a screenshot.
3. Captures are saved under `.mol4agent/captures/` in the workspace. If the
   current model route declares image input, the image is also returned to the
   model.

**Rollout**: a Host-side change (`lib/host.js`) needs a DSH restart; a client-side
change (`lib/client.js`) only needs a page refresh.

## Quick start (ChatGPT/Codex)

Build and install the plugin into a local Codex marketplace:

```sh
pnpm --filter @gcszhn/mol4agent-core build
pnpm --filter @gcszhn/mol4agent-chatgpt build
node packages/chatgpt/scripts/install-local.mjs
codex plugin marketplace add ~/.codex/mol4agent-marketplace
codex plugin add mol4agent@mol4agent-local
```

Start a new conversation and ask:

> Open fixtures/1atp.pdb, use cartoon with chain-id coloring, highlight ATP,
> focus it, and capture a screenshot.

You can also click `fixtures/1atp.pdb` in the file tree. The first open asks
whether to use mol4agent for `.pdb` files; choose **Yes** once, and the structure
opens in the side panel by default. **Open with** still offers the built-in
text/code viewer. See the [ChatGPT adapter README](packages/chatgpt/README.md)
for the tool reference and file-handler details.

## Development

```sh
pnpm install
pnpm typecheck   # builds core first, then typechecks every package
pnpm build       # every package: core, DSH host/client, ChatGPT server/app
```

`build` produces:

- `lib/host.js` — DSH Host, ESM, `@deepseek-ai/*` external;
- `lib/client.js` — DSH lazy-CJS browser bundle with Mol*'s official UI, about
  3.65 MiB. One bundle, no lazy chunk.

## Documentation

- [Core API](packages/core/README.md): `createMolViewer`, `StructureData`,
  commands, selectors, summaries, capture, React binding.
- [DSH agent interface](packages/deepseek-harness/README.md): `mol_*` tools,
  session projection, document preview, screenshot loop.
- [ChatGPT/Codex adapter](packages/chatgpt/README.md): MCP App, file-tree
  structure preview, `mol_*` tools, long-poll scene updates, capture rendezvous,
  local install.
- [Architecture design](docs/architecture.md) / [中文](docs/architecture_zh.md): product
  goals, layers, the cross-harness contract, and high-level flows. Package
  details live in the package docs.
- [DSH adapter details](packages/deepseek-harness/docs/DETAIL.md): tool behavior,
  selector examples, limitations.

Chinese translations: [README_zh.md](README_zh.md),
[core](packages/core/README_zh.md),
[DSH adapter](packages/deepseek-harness/README_zh.md).
