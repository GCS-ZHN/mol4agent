# AGENTS.md

Repository-level routing and cross-cutting constraints for future agent
sessions. Read the package playbook before changing that package:

- **Core** (`packages/core/`): [`packages/core/AGENTS.md`](packages/core/AGENTS.md)
  — protocol, Mol* viewer lifecycle, rendering, capture, packaging.
- **DSH adapter** (`packages/deepseek-harness/`):
  [`packages/deepseek-harness/AGENTS.md`](packages/deepseek-harness/AGENTS.md)
  — Host/client split, projection, tools, preview, screenshot loop, packaging.
- **ChatGPT/Codex adapter** (`packages/chatgpt/`):
  [`packages/chatgpt/AGENTS.md`](packages/chatgpt/AGENTS.md)
  — MCP server/app split, tools, long-poll, capture rendezvous, packaging.
- **OpenCode adapter** (`packages/opencode/`):
  [`packages/opencode/AGENTS.md`](packages/opencode/AGENTS.md)
  — server/GUI split, RPC, per-location `globalThis` store, esbuild GUI build,
  capture rendezvous, packaging.

API, architecture, and tool references stay in the READMEs; do not duplicate
them here or in code comments:

- `README.md` / `README_zh.md`
- `packages/core/README.md` / `README_zh.md`
- `packages/deepseek-harness/README.md` / `README_zh.md`
- `packages/chatgpt/README.md` / `README_zh.md`
- `packages/opencode/README.md` / `README_zh.md`
- `docs/architecture.md` / `docs/architecture_zh.md` (architecture; English default)
- `packages/deepseek-harness/docs/DETAIL.md`

## Product goals

The canonical cross-harness goals and acceptance criteria live in
[docs/architecture.md](docs/architecture.md) §1.3. Read them before changing
behavior; do not restate them here. Implementation requirements for each package
are in its AGENTS playbook.

## Cross-cutting constraints

- Treat the core/adapter boundary in the READMEs as immutable. If a change needs
  path detection, IO, or session state in core, it is in the wrong package.
- Use the official Mol* UI (`createPluginUI` + `DefaultPluginUISpec`); do not
  reintroduce the headless viewer, the `Viewer` wrapper, or a custom toolbar.
- Viewer state is **tab-page scoped and preserved**: one tab is one viewer and
  one scene. Human preview-mode switches and agent `mol_open` share the body,
  never a mutable scene across tabs. Switching tabs (panel tabs, document tabs,
  or sessions while the tab stays open) must reveal/reattach the existing
  viewer; never remount or reload it, because that resets the camera pose,
  style/color, selection, and measurements. Reset state only when the tab is
  closed or a structure is explicitly reloaded. Read
  [architecture §1.3.1](docs/architecture.md#131-sidebar-tab-state-and-file-open-paths)
  before changing the preview, bridge, projection, or capture routing.
- Keep agent operations on `mol_*` tools. Shell/code is for calculations
  (interface geometry, H-bond candidates, builds), not for driving the viewer.
- A new selector/command/tool is a cross-package change: update core semantics,
  every adapter, the prompt, and the relevant READMEs in the same change.
- Verify with `pnpm typecheck`, the package build, `pnpm test`, real fixtures,
  and the actual harness page. A screenshot alone does not prove panel/layout
  behavior.
- A new package/adapter is a cross-cutting change: wire it into
  `.github/workflows/ci.yml` (install, core build, typecheck, unit tests,
  package build) and, when publishable, into `.github/workflows/release.yml`
  (build/test, version-match loop, publish step). Every package ships unit tests
  for its pure logic (suffix/format detection, selectors, scene store, capture
  hub, summaries) plus a `test` script that CI runs; a manual harness check does
  not replace those tests.
- Documentation defaults to English with a synchronized `README_zh.md`. Update
  the relevant READMEs when behavior or APIs change.
- npm packages contain compiled JS/`.d.ts` plus only the assets/config each
  package allowlists (locale, docs, icon, patch); never `src/`, `AGENTS.md`, or
  build scripts. Use the package `files` allowlist; `lib/` is build output and
  stays out of git.
- Keep package changes scoped; read the package playbook, review the final diff,
  and commit separately.
