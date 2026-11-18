# AGENTS.md — core

Read the [core README](README.md) for the public API and the root
[`AGENTS.md`](../../AGENTS.md) for cross-cutting rules. This file records
core-only invariants and traps. Core is the shared semantic source for the
product goals in [`docs/architecture.md`](../../docs/architecture.md) §1.3;
keep its protocol consistent for every adapter.

## Contracts

- `StructureData` is **bytes + explicit `MolFormat`**; core never receives a path,
  inspects a suffix, or imports a harness SDK, filesystem, network, or session API.
- `sources.ts` maps entry ids to download plans (URL, optional JSON index field,
  format, file name) and must stay network/filesystem-free; downloading and
  writing are adapter jobs.
- Text formats passed as `Uint8Array` must be UTF-8 decoded; honor `binary` for
  BCIF. A PDB wrapped as a Binary data object produces an empty hierarchy.
- Loading is a method, not a command; commands stay JSON-serializable and
  replayable. Adding a selector/command variant is a protocol change: update
  `protocol.ts`, `select.ts`, this package's README, and the DSH validator/
  projection in the same change.
- Inspection is a **read method**, `viewer.inspect()` (`inspect*.ts`), never a
  command op: it must stay out of `MolCommand` so the session log stays a replay
  of changes. It reads live Mol* state on purpose, including human-made
  selections and styles, so never re-derive it from the command log. Keep the
  Mol*-free aggregation (`inspect.ts`) separate from the extractor
  (`inspect-mol.ts`) and plugin wiring (`inspect-plugin.ts`) so the pure part
  stays testable under Node.
- Appearance keeps `baseColor` (the representation's own theme colour) and
  `visibleColor` (what is actually drawn) distinct, with a fixed precedence:
  overpaint replaces the theme colour, then the selection marker mixes over it
  using `canvas3d.props.renderer` (`selectColor`, `selectStrength`,
  `colorMarker`). Both are sampled at one matched element; never derive them
  from the command log.

## Viewer lifecycle

- Mount the official UI with `createPluginUI` + `DefaultPluginUISpec`. No
  headless `PluginContext`, no `Viewer` wrapper, no custom toolbar.
- Choose `portrait`/`landscape` from the **viewer container** aspect ratio, not
  the browser window. `reactive` uses window media queries and breaks in DSH's
  sidebar.
- Start with `showControls: false`: Mol* gates every official panel region
  (sequence, State Tree, Structure Tools) behind it. The viewport sliders button
  toggles the whole set. Do not turn it on by default to "fix" one panel.
- Inject the theme stylesheet and subscribe to runtime theme changes; swap the
  CSS and canvas background via `setTheme`. Do not bake the initial theme in.
- `load()` must clear the previous structures/trajectories **and the root
  measurement group** before adding the new one. Otherwise components,
  selection representations, and measurement labels accumulate across reloads.

## Representations

- Global `cartoon` uses the `polymer-and-ligand` preset so HETATM ligands remain
  visible; `colorParams` must be passed through the preset theme.
- `represent.replace` is explicit and defaults to `true`. With replace, clear
  the structure components **before** building either style family, then build;
  the preset would otherwise update its tagged components in place and leave
  earlier non-preset/targeted components behind. With `replace: false`, never
  clear: add a selection component for a target, or a fresh all-atom component
  for a global style.
- `target` only narrows the new representation's coverage; it never implies add
  or replace. With `replace: true` the whole scene is replaced even when a
  target is present.
- Do not remove pre-command refs *after* applying the preset: the refs can be
  the same transforms and removing them blanks the viewport. Clear before.
- Avoid deleting reused components by ref after building a fresh component: it
  can take the new representation with it. The pre-clear avoids that.
- `capture()` renders the viewport only; use it through the DSH capture
  rendezvous, not as a substitute for verifying the page UI.

## Build and packaging

- `pnpm --filter @gcszhn/mol4agent-core build` runs `tsc -p tsconfig.build.json`
  and emits `lib/*.js` plus `lib/*.d.ts`.
- Package `exports` point at `lib`, never `src`; `files` allows only `lib` and
  the READMEs, so source and `AGENTS.md` are not packed. `prepack` builds first.
- Keep `.ts` import extensions in source; the build rewrites them to `.js`.
  Files used by Node (protocol/parse) must stay compatible with Node type
  stripping.
- The viewer JS imports Mol* CSS; browser consumers need a CSS/bundler loader.
  `protocol` and `parse` subpaths remain Node-safe.
- Do not commit `lib/`; it is generated and gitignored.

## Verification

- `pnpm typecheck` (root builds core first), then
  `pnpm --filter @gcszhn/mol4agent-core test` and
  `pnpm --filter @gcszhn/mol4agent-core build`.
- `test/represent.test.ts` drives a real headless Mol* `PluginContext` and
  asserts the live hierarchy, so run it for any change to `represent` or the
  preset/component lifecycle. It is test-only; the product viewer still mounts
  the official UI.
- Verify real fixtures: 1CRN PDB/CIF, 1ATP, aspirin SDF, 7CZD. Exercise load,
  global style, targeted style, focus, and capture.
- For UI changes, use headless Chrome + SwiftShader and click the actual viewport
  buttons; a canvas screenshot can hide a broken panel/layout.
