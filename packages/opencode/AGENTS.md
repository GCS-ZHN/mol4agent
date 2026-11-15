# AGENTS.md — OpenCode adapter

Read the [README](README.md) for the tool/API reference and the root
[`AGENTS.md`](../../AGENTS.md) for cross-cutting rules. This file records
OpenCode-adapter-only invariants and traps. This adapter must satisfy the
product goals in [`docs/architecture.md`](../../docs/architecture.md) §1.3;
document any unavoidable adapter-specific limitation in the README rather than
changing core semantics.

## Server / GUI split

- The **server part** (`src/server.ts`) is the only place that sees paths,
  reads bytes, and stores the scene log. Core receives `{ data, format, label }`
  only. The **GUI part** (`src/gui/`) owns Mol*/WebGL and never touches the
  filesystem.
- Mutating tools append JSON commands to the shared store and emit a `scene`
  event; `mol_capture` enqueues in the shared hub and emits a `capture` event.
  Never push WebGL objects or bytes into scene commands.

### Per-location loading (the biggest trap)

OpenCode loads a plugin **once per location** and re-evaluates the module per
location, so neither closure state nor module state is shared across locations.
RPC **events** broadcast across locations, but RPC **methods** are
location-scoped. The agent runs in one location while the GUI panel lives in
the desktop app's location, so the scene store must be a single process-wide
instance. Pin it on `globalThis`:

```ts
const g = globalThis as unknown as Record<string, unknown>
const store = (g['__mol4agent_opencode__store'] ??= new SceneStore()) as SceneStore
const captures = (g['__mol4agent_opencode__captures'] ??= new CaptureHub()) as CaptureHub
```

Do not move `store`/`captures` back into `setup` or onto a module-level `const`;
both are per-location. `globalThis` is per-process, which is the scope the RPC
event broadcast reaches.

## RPC

- `src/rpc.ts` defines one `Rpc.define({ id: 'mol4agent', ... })` token. The
  server bundles its own copy and the GUI bundles another; they match by `id`.
  Do not rely on object identity.
- `events.emit` broadcasts; `events.on`/`events.subscribe` are live-only. The
  GUI must do an initial `listScenes({})` on mount, not only follow events.
- Event payloads are objects (`event.data`). Method inputs are JSON Schema, so
  handlers receive `unknown`; cast and validate defensively.

## Tools

- Register tools with `ctx.tool.transform(editor => editor.add({...}))`. The
  tool `input` is a JSON Schema; `execute(input, context)` receives `unknown`
  input plus `context.sessionID`/`context.signal`.
- Resolve the workspace with `(await ctx.session.get({ sessionID })).location.directory`,
  not `process.cwd()` (the server cwd is not the workspace).
- OpenCode tool results have **no inline image content** (only `text`/`file`).
  `mol_capture` returns the saved path and a `file` content reference; it cannot
  attach the PNG to the model context. Document this in the README.

## GUI build (Vite, not esbuild)

- The GUI bundle must be built with Vite via the `gui()` preset from
  `@opencode/plugin/gui/vite` (`vite-plugin-solid`). Solid 1.9 **removed** the
  standard `jsx`/`jsxs`/`Fragment` exports, so esbuild's automatic JSX cannot
  compile Solid components (the `solid-js/jsx-runtime` alias is a legacy stub,
  and `solid-js/h` is a hyperscript runtime, not a component runtime). Do not
  replace Vite with esbuild for the GUI.
- core imports Mol*'s theme CSS as a default-exported string; redirect `.css`
  through Vite's `?inline` query (see `vite.config.ts`'s `cssAsText`). Vite's
  normal CSS pipeline does not provide a string default export.
- The app shares `solid-js`, `solid-js/web`, `solid-js/store`, `effect`,
  `@opencode/*`, `electron`, and Node builtins. Everything else (Mol*, React,
  core) is bundled. Alias `react`/`react-dom` to one React 18 instance.
- The GUI bundle's module scope is evaluated in the Electron **main** process
  too. Lazy-import `@gcszhn/mol4agent-core` inside the viewer component so
  Mol*/React are never evaluated in main (no DOM there).

## Verification

- `pnpm --filter @gcszhn/mol4agent-opencode typecheck`, then the package build
  (`node scripts/build.mjs && vite build`). Core must be built first.
- The server part hot-reloads on `dist/index.js` rebuild + `/reload`; the GUI
  hot-reloads in every window on `dist/gui.cjs` rebuild. A plugin whose GUI
  first-load **failed** ("requires a module the app does not share") needs a
  desktop-app restart — it does not retry on rebuild.
- Verify with real fixtures (1CRN/1ATP/aspirin/7CZD): `mol_info`,
  `mol_interface`, `mol_open` + `mol_style`/`mol_select`/`mol_focus`/
  `mol_measure`, and `mol_capture` returning a non-trivial PNG. Check
  `~/Library/Application Support/ai.opencode.desktop/logs/<run>/renderer.log`
  for the GUI console, and `~/.local/share/opencode/log/opencode.log` for the
  server.
