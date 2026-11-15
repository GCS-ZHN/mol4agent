# AGENTS.md

Repository-specific working agreement for future agent sessions. Read this before
changing code; it records decisions and traps, not the API. The API and
architecture belong in:

- `README.md` / `README_zh.md` — project overview and package map
- `packages/core/README.md` / `README_zh.md` — core API and command protocol
- `packages/deepseek-harness/README.md` / `README_zh.md` — DSH tools and integration
- `docs/architecture.md` — design notes (Chinese)
- `packages/deepseek-harness/docs/DETAIL.md` — behavior details

Do not copy those sections into code comments or new docs; link to them.

## Non-negotiable boundaries

- Core receives **bytes plus an explicit `MolFormat`**. It never receives a path,
  never inspects a suffix, and never imports a harness SDK, filesystem, network,
  or session API.
- Path resolution, suffix detection, authorization, file reads, sessions, and UI
  live in the adapter. If a feature needs any of those, it belongs in the
  adapter, not in core.
- DSH reads bytes with DSH APIs and passes `{ data, format, label }` to core.
  ChatGPT/Codex is one future adapter (raw data), not two.
- A new selector/command format change is a protocol change: update core, the
  DSH validator/projection, and the READMEs in the same change.

## Viewer decisions

- **Official Mol* UI only** (`createPluginUI` + `DefaultPluginUISpec`). Do not
  bring back the headless viewer, the `Viewer` wrapper, or a custom toolbar.
  The viewport controls and panels are Mol*'s.
- **Layout is chosen from the viewer container's aspect ratio**, not the browser
  window. `portrait` for tall containers, `landscape` for wide ones. The `reactive`
  mode keys off the window and breaks inside DSH's sidebar.
- **Official panels start closed** (`showControls: false`). In Mol*,
  `showControls` gates every region (sequence, State Tree, Structure Tools), so
  setting it false closes the whole official panel set; the viewport's sliders
  button toggles it. Do not "fix" individual panels by turning it on by default.
- **Theme changes at runtime**: inject the full theme CSS, subscribe to DSH
  `theme/change`, and swap the stylesheet plus canvas background. Do not bake the
  initial theme into the viewer forever.

## State and lifecycle traps

- One viewer per document tab. Keep effect dependencies stable; do not recreate
  the viewer on locale/inject/theme identity changes.
- Tab switches must reattach the live Mol* container (LRU 2), not reload the
  file. There is no HMR watcher in this profile; client changes need a page
  refresh.
- `load()` must **clear the previous structures/trajectories first**. Otherwise
  old components and their selection representations accumulate across reloads.
- DSH `readBytes` returns `Uint8Array` even for PDB/mmCIF. Decode text formats;
  honor `binary` for BCIF. Passing a PDB as a Binary data object produces an
  empty hierarchy.
- Global `cartoon` uses the `polymer-and-ligand` preset so ligands remain
  visible; `colorParams` goes through the preset theme.
- Targeted `represent` is **additive**: it creates a new selection component and
  must not remove other representations. Do not "replace" the scene for a
  target.
- The representation preset updates tagged representations **in place**. Do not
  remove pre-command representation refs on the preset path; those refs can be
  the same transforms, and removing them blanks the viewport.
- Prefer old-reference snapshots over deleting reused components. Component
  reuse makes naive "clear then add" code delete the new representation.
- Build the all-atom global representation as a fresh component when bypassing
  the preset; removing old components is safer than removing old reps there.

## DSH integration

- Host tools validate arguments and read files; the **projection** turns the
  recorded `tool/call` into viewer commands. Do not mutate the viewer directly
  from a Host tool body.
- Mutating tools use `isConcurrencySafe: () => false`.
- Adding a tool means updating `tools.ts`, `projection.ts`, `prompt.ts`, and both
  DSH READMEs; otherwise the model cannot discover or replay it.
- Capture is a rendezvous: `mol_capture` blocks in `CaptureHub`; the page renders
  and calls the internal `/mol4agent_capture` command. Do not replace this with a
  custom HTTP route, remote service, or attachment-directory polling.
- The document preview is `priority: 'extension'` with a body in
  `sidebar.right.tab.document`; keep bytes flowing through the adapter's
  `readBytes`, never through core path logic.
- Host code changes need a DSH restart or a bundle reload; client changes need a
  page refresh. Do not claim live HMR for client code without the dev watcher.
- `mol_interface` is PDB-like only (`pdb`/`pdbqt`/`pqr`); do not silently pretend
  it supports mmCIF/BCIF.

## Build and packaging

- The DSH client is **one bundle** containing core, Mol*, and the official UI CSS.
  Do not reintroduce the lazy `client.molstar.js` chunk: it failed through
  Desktop's `dsh-app://` protocol.
- Keep `react`, `react-dom`, `react-dom/client`, `react/jsx-runtime`, and
  `@deepseek-ai/*`/`node:*` external as the build script does. CSS is bundled
  with the text loader.
- Write outputs through temp files + atomic rename. A page can load during a
  rebuild; never delete `lib/` before building.
- Run `pnpm -r typecheck` and the adapter build after source changes. Do not
  commit `lib/`, `node_modules/`, or `.mol4agent/`.

## Verification

- Use real fixtures (`1crn`, `1atp`, `aspirin`, `7czd`) and test both load and
  command paths. For Mol* UI work, use headless Chrome + SwiftShader and click
  the actual viewport buttons; screenshots alone can hide a layout bug.
- Exercise the real DSH page: panel default/toggle, theme switch, tab switch
  without reload, reload same file without component accumulation, interface
  target styling, and capture delivery.
- Agent operations must go through `mol_*` tools. Shell/code is acceptable for
  calculations (interface geometry, H-bond candidates, builds), not for
  operating the viewer.
- After behavior or API changes, update the corresponding README and `_zh`
  counterpart. Keep the final diff focused and commit it separately.

## TypeScript and style

- ESM with `.ts` import extensions (the workspace enables
  `allowImportingTsExtensions`). Keep files imported by Node compatible with
  Node's type stripping: avoid parameter properties and other syntax that
  requires a transform.
- Prefer existing DSH/Mol* APIs over new dependencies or custom UI.
- Comments should explain decisions and traps, not restate the public API.
