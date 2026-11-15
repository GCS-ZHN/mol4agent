# AGENTS.md — OpenCode adapter

Read the [README](README.md) for the tool/API reference and the root
[`AGENTS.md`](../../AGENTS.md) for cross-cutting rules. This file records
OpenCode-adapter-only invariants and traps. This adapter must satisfy the
product goals in [`docs/architecture.md`](../../docs/architecture.md) §1.3;
document any unavoidable adapter-specific limitation in the README rather than
changing core semantics.

## Compatibility

- Requires `@opencode/plugin` **`>=2.2.0 <3.0.0`** — the `./gui` window API
  (`./gui`, `./gui/file`, `./gui/vite`, Panel/RPC registration) landed in 2.2.0.
  Built and verified on 2.3.0. Do not claim support for older versions.
- OpenCode v1 has no GUI plugin layer, no custom RPC, and no DOM/WebGL, so this
  adapter cannot run there; only the text-only `mol_info`/`mol_interface` tools
  could be ported. It is a v2.2+ GUI-plugin artifact.

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
const STORE_SCHEMA = 'v2'
const globalKey = `__mol4agent_opencode_${STORE_SCHEMA}__`
const g = globalThis as unknown as Record<string, unknown>
const store = (g[`${globalKey}store`] ??= new SceneStore()) as SceneStore
const captures = (g[`${globalKey}captures`] ??= new CaptureHub()) as CaptureHub
```

Do not move `store`/`captures` back into `setup` or onto a module-level `const`;
both are per-location. `globalThis` is per-process, which is the scope the RPC
event broadcast reaches. Bump `STORE_SCHEMA` whenever the store's shape changes:
hot-reloading with `??=` otherwise keeps the stale instance from the previous
build (`store.snapshot is not a function`).

### Session buckets and tab targeting

- One server process serves several sessions. `SceneStore` is **bucketed per
  `sessionID`** (`open`/`push`/`snapshot`/`active`/`list` all take it), so one
  session's `mol_open` or style never mutates another session's panel. The GUI
  filters `listScenes`/`pendingCaptures` and `scene`/`capture` events by
  `ctx.sessions.current()`.
- Each bucket keeps path-keyed tabs; `mol_open` returns `tab` (the absolute
  path) and every scene tool accepts it to target a non-active tab. Without
  `tab`, tools target the session's last `mol_open`.
- A session keeps at most 12 tabs (oldest non-active evicted); `byId` maps
  `sceneId` to the record for `fetchScene`. Reopening a path replaces its tab
  and invalidates the old `sceneId`.

## RPC

- `src/rpc.ts` defines one `Rpc.define({ id: 'mol4agent', ... })` token. The
  server bundles its own copy and the GUI bundles another; they match by `id`.
  Do not rely on object identity.
- `events.emit` broadcasts; `events.on`/`events.subscribe` are live-only. The
  GUI must run `listScenes({ sessionID })` on mount **and whenever the routed
  session changes** (`createEffect` on `ctx.sessions.current()`), plus claim
  `pendingCaptures({ sessionID })` at the same points — not only follow events.
- `scene` and `capture` payloads carry `sessionID`. A `scene` event from
  `mol_open`/`openPath` also carries `path` and `open: true`; the GUI opens that
  tab, and queues it when another session is routed (then opens it on switch).
  `capture` carries `path` so the GUI can reveal the right tab without a scene
  lookup. Ignore payloads for another session; do not deliver their captures in
  the current one.
- Event payloads are objects (`event.data`). Method inputs are JSON Schema, so
  handlers receive `unknown`; cast and validate defensively. Keep the
  `pendingCaptures` output schema in sync with what the server returns.

## Tools

- Register tools with `ctx.tool.transform(editor => editor.add({...}))`. The
  tool `input` is a JSON Schema; `execute(input, context)` receives `unknown`
  input plus `context.sessionID`/`context.signal`.
- Resolve the workspace with `(await ctx.session.get({ sessionID })).location.directory`,
  not `process.cwd()` (the server cwd is not the workspace).
- OpenCode tool results have **no inline image content** (only `text`/`file`).
  `mol_capture` returns the saved path and a `file` content reference; it cannot
  attach the PNG to the model context. Document this in the README.

## GUI build (esbuild + JSX-free Solid)

- The GUI bundle is built with **esbuild**, not Vite. Vite's
  `inlineDynamicImports` inlines the lazy `import("@gcszhn/mol4agent-core")`
  eagerly, so Mol*'s Markdown dependency runs `document.createElement("i")` at
  module scope and crashes the Electron **main** process on every fresh app
  start (it only "worked" earlier via window hot-reload while main held an older
  bundle). esbuild keeps the dynamic import lazy.
- Solid 1.9 has no standalone `jsx`/`jsxs`/`Fragment` runtime (`solid-js/jsx-runtime`
  points at core, which does not export them; `solid-js/h` is a hyperscript
  runtime, not a component runtime). The GUI source therefore uses **no JSX**:
  `createComponent` for components and imperative `document.createElement` for
  elements. Do not reintroduce JSX.
- The app shares `solid-js`, `solid-js/web`, `solid-js/store`, `effect`,
  `@opencode/*`, `electron`, and Node builtins. Everything else (Mol*, React,
  core) is bundled. Alias `react`/`react-dom` to one React 18 instance.
- core imports Mol*'s theme CSS as a default-exported string; esbuild's
  `loader: { '.css': 'text' }` provides it. Route core through one lazy
  `loadCore()` so its dependency graph is never inlined eagerly.

## Human open

- The built-in file tree does not route a `.pdb` click to plugins: it opens the
  text editor, and a `FileViewer` for the `"text"` kind is ignored by the host
  (it only renders kinds the file view does not render itself). Automatic
  file-tree interception is not possible; document the limitation in the README.
- Provide human paths instead: **Ctrl+P file search** (the `/open` command) via
  `LinkHandler` (this is the only file-search route that reaches the handler)
  and the pick-file command. Do **not** register a `/mol_open` slash command:
  its name collides with the agent tool `mol_open`. `LinkHandler.open` may
  receive only the basename, so cache the full path seen in `match` and reuse it
  in `open`. Reject non-`file://` URLs so a remote link is never treated as a
  path.

## Verification

- `pnpm --filter @gcszhn/mol4agent-opencode typecheck`, `test` (Node's
  `--experimental-strip-types` runner), then the package build
  (`node scripts/build.mjs`). Core must be built first.
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
- GUI matrix (manual): switch between two sessions with open scenes, toggle
  light/dark after opening a structure, mount on an existing scene, request a
  capture while switching sessions, and style/capture two tabs independently.
  Check the panel strip and the PNGs.
