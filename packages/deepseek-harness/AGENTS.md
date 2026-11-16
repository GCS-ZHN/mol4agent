# AGENTS.md — DSH adapter

Read the [DSH README](README.md) for the tool/API reference and the root
[`AGENTS.md`](../../AGENTS.md) for cross-cutting rules. This file records
adapter-only invariants and traps. This adapter must satisfy the product goals
in [`docs/architecture.md`](../../docs/architecture.md) §1.3; document any
unavoidable adapter-specific limitation in the README rather than changing core
semantics.

## Host/client split

- Host tools validate arguments and read files for summaries; the **session
  projection** turns the recorded `tool/call` into viewer commands. Never mutate
  the viewer directly from a Host tool body.
- The browser body follows the projection, reads bytes through
  `remote.workspaceFiles.readBytes`, and calls core with `{ data, format, label }`.
- Gzip is adapter transport: recognize `.gz` variants, decode in the Host and in
  the browser before calling core, and enforce the decompressed-size cap. Never
  pass compressed bytes to core or Mol*.
- Add a tool in `tools.ts`, fold it in `projection.ts`, describe it in
  `prompt.ts`, and update both READMEs. Mutating tools use
  `isConcurrencySafe: () => false`. Tools without a scene effect (`mol_info`,
  `mol_interface`, `mol_fetch`) are ignored by the projection.
- `mol_fetch` is Host-only: core resolves the entry id to a download plan, then
  the Host downloads and writes the file (HTTPS, 64 MiB cap, temp file +
  rename). It must not touch the viewer or the projection.
- Selector validation (`selector.ts`) and core selector support must change
  together; an accepted selector that fails in `compileSelector` is a bug.
- Screenshot capture is a rendezvous: `mol_capture` blocks in `CaptureHub`, the
  page renders and calls the internal `/mol4agent_capture` command. Do not
  replace this with a custom HTTP route, remote service, or file polling.

## Document preview

- Register `mol4agent/molstar` with `priority: 'extension'`, the suffix lists in
  `formats.ts`, and `binaryExtensions: ['bcif']`. Keep the body in
  `sidebar.right.tab.document` keyed by the implementation id.
- Keep path parsing and format mapping in this adapter; core only receives bytes
  plus format. Do not add path logic to core for a preview feature.
- The projection is keyed by **tab page id (absolute path)**: `mol_open` adds or
  replaces `tabs[path]` and sets `active`; scene tools fold into `args.tab`
  (default `active`). Never reintroduce a single session-wide `scene`.
- The body selects `tabs[path]` for its own tab; do not let one tab apply another
  tab's commands. Capture pending carries the target `path`; the bridge activates
  that tab and only its body delivers.
- The header bridge opens a new or reopened tab; do not auto-open tabs that
  already existed when a session was restored.

## Viewer behavior

- Use core's official Mol* UI; no custom toolbar. Layout mode comes from the
  container aspect ratio; panels start closed (`showControls: false`) and the
  viewport sliders button opens the official set.
- Theme follows DSH `theme/change`; do not snapshot it once.
- Tab switches reattach the live Mol* container (cache LRU 2); do not reload the
  file or recreate the viewer. Plugin unload disposes cached viewers.
- `viewer.load()` clears the previous structure; do not skip that on new scenes
  or reloads.
- Client changes need a page refresh; Host changes need a DSH restart or a bundle
  reload. Do not claim live HMR without the dev watcher.

## Build, package, install

- `pnpm build` (core first, then this package) produces
  `lib/host.js` and `lib/client.js`. The client is one bundle containing core,
  Mol*, and the official UI CSS; no lazy chunk (Desktop `dsh-app://` is
  unreliable for chunks).
- Keep `react`, `react-dom`, `react-dom/client`, `react/jsx-runtime`, and
  `@deepseek-ai/*`/`node:*` external as configured. Bundle CSS with the text
  loader.
- Write outputs through temp files + atomic rename; a page can load during a
  rebuild.
- Package `files` is an allowlist (`lib`, `locale`, `docs`, `icon.svg`,
  `cordis.patch.yml`, `README_zh.md`); `src/`, `AGENTS.md`, and build scripts are
  not packed. `prepack` runs the build.
- Install via `plugin_manager`. Host code changes need a restart/bundle reload;
  client changes need a refresh. Do not commit `lib/`, `node_modules/`, or
  `.mol4agent/` captures.

## Verification

- Run `pnpm typecheck` (builds core first), `pnpm build`, and
  `pnpm --filter @gcszhn/mol4agent-deepseekharness test`.
- Test the real DSH page: panel default closed and toggle, theme switch, tab
  switch without reload, reload same file without component accumulation,
  interface target styling, and capture delivery.
- Exercise agent operations through `mol_*` tools. Shell/code is only for
  interface/H-bond calculations and builds, not for operating the viewer.
- Verify the npm pack dry-run contains compiled JS/d.ts and no source or
  `AGENTS.md`.
