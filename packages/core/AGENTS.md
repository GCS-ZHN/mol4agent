# AGENTS.md — core

Read the [core README](README.md) for the public API and the root
[`AGENTS.md`](../../AGENTS.md) for cross-cutting rules. This file records
core-only invariants and traps. Core is the shared semantic source for the
product goals in [`docs/architecture.md`](../../docs/architecture.md) §1.3;
keep its protocol consistent for every adapter.

## Contracts

- `StructureData` is **bytes + explicit `MolFormat`**; core never receives a path,
  inspects a suffix, or imports a harness SDK, filesystem, network, or session API.
- Text formats passed as `Uint8Array` must be UTF-8 decoded; honor `binary` for
  BCIF. A PDB wrapped as a Binary data object produces an empty hierarchy.
- Loading is a method, not a command; commands stay JSON-serializable and
  replayable. Adding a selector/command variant is a protocol change: update
  `protocol.ts`, `select.ts`, this package's README, and the DSH validator/
  projection in the same change.

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
- Targeted `represent` is **additive**: create a selection component and add a
  representation there; never remove the rest of the scene for a target.
- The preset updates tagged representations **in place**. Do not remove
  pre-command representation refs on the preset path; they can be the same
  transforms and removing them blanks the viewport.
- When bypassing the preset for a global style, build a fresh all-atom component
  and remove the old components. Avoid deleting reused components by ref, which
  can take the new representation with them.
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
- Verify real fixtures: 1CRN PDB/CIF, 1ATP, aspirin SDF, 7CZD. Exercise load,
  global style, targeted style, focus, and capture.
- For UI changes, use headless Chrome + SwiftShader and click the actual viewport
  buttons; a canvas screenshot can hide a broken panel/layout.
