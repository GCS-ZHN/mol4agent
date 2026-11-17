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

## Versioning and releases

### Version numbers

- Every package under `packages/` owns its version; there is no repository-wide
  release version. The root `package.json` version is metadata, not a release
  marker.
- Bump a package version in the same PR that changes its published artifact.
  Do not use a separate version-only PR, and do not create release tags.
- Patch (`0.1.1`) is a bug fix with no API or behavior-contract change. Minor
  (`0.2.0`) adds a capability or changes observable behavior; while a package
  is `0.x`, a minor bump is also a compatibility boundary and may break
  consumers. Major (`1.0.0`) is breaking; compatibility is not guaranteed.
- Bump only packages whose published artifact changes. Repo-only changes (CI,
  `AGENTS.md`, architecture docs, root README) bump nothing. A package README
  ships in the tarball, so changing one counts as an artifact change.
- Never reuse a published version. The release workflow skips versions already
  present on npm or `plugin-dist`; ship a fix with a new version.
- A change spanning core and adapters bumps core plus every adapter that must
  ship it. An adapter-only change bumps only that adapter; do not bump core or
  unrelated adapters.
- Keep every hardcoded version string equal to `package.json`: the ChatGPT
  `.codex-plugin/plugin.json` and the `VERSION` constants in `src/server.ts`
  and `src/client/main.ts`, plus the DSH HTTP `User-Agent` in
  `src/host/fetch.ts`. The release script fails on a package/plugin mismatch.

### Core dependency and bundled adapters

- Adapters declare core with the workspace protocol, never `workspace:*`:
  `workspace:^` normally, or an explicit `workspace:>=x.y.z <1.0.0` when the
  release depends on a newer core capability. Publishing rewrites either form
  to the corresponding normal range. DSH's build-time core dependency uses
  `workspace:>=0.2.0 <1.0.0` (published as `>=0.2.0 <1.0.0`) so its bundle can
  be built against any 0.x core. Other published dependencies use ranges too,
  except host-provided peer APIs that must pin the host version.
- Every adapter bundles core into its artifacts: DSH `host.js`/`client.js`,
  ChatGPT `server.js`/`viewer.html`, and OpenCode `index.js`/`gui.cjs`. A core
  patch does **not** reach an installed adapter on its own. Each adapter that
  should ship the fix must bump and republish; the rebuild embeds the new core,
  and `workspace:^` rewrites the manifest without a dependency edit.
- Core patch releases can therefore be adopted by republishing adapters with no
  code change. Core minor/major releases are compatibility boundaries: review
  and test each adapter, then bump and republish the ones that adopt them.

### Release execution

- Releases run from `.github/workflows/release.yml` after `ci` succeeds on
  `main`. `.github/scripts/release-packages.mjs` checks each package's version
  against its release target (npm for core/DSH/OpenCode, the `plugin-dist`
  branch for ChatGPT) and skips versions already published. Do not reintroduce
  tag-triggered releases or a repository-wide version check.
- The ChatGPT plugin has no npm package: its release artifact is the
  force-pushed `plugin-dist` branch, and its version bump is what republishes
  it.

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
  package build) and, when publishable, into
  `.github/scripts/release-packages.mjs` (publish step and ordering). Every
  package ships unit tests for its pure logic (suffix/format detection,
  selectors, scene store, capture hub, summaries) plus a `test` script that CI
  runs; a manual harness check does not replace those tests.
- Documentation defaults to English with a synchronized `README_zh.md`. Update
  the relevant READMEs when behavior or APIs change.
- npm packages contain compiled JS/`.d.ts` plus only the assets/config each
  package allowlists (locale, docs, icon, patch); never `src/`, `AGENTS.md`, or
  build scripts. Use the package `files` allowlist; `lib/` is build output and
  stays out of git.
- Keep package changes scoped; read the package playbook, review the final diff,
  and commit separately.
