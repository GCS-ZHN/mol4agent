# AGENTS.md

Repository-level routing and cross-cutting rules for future agent sessions.
Read the package playbook before changing that package:

- **Core** (`packages/core/`): [`packages/core/AGENTS.md`](packages/core/AGENTS.md)
  — protocol, Mol* viewer lifecycle, rendering, capture, packaging.
- **DSH adapter** (`packages/deepseek-harness/`):
  [`packages/deepseek-harness/AGENTS.md`](packages/deepseek-harness/AGENTS.md)
  — Host/client split, projection, tools, preview, screenshot loop, packaging.

API, architecture, and tool references stay in the READMEs; do not duplicate
them here or in code comments:

- `README.md` / `README_zh.md`
- `packages/core/README.md` / `README_zh.md`
- `packages/deepseek-harness/README.md` / `README_zh.md`
- `docs/architecture.md` (Chinese design notes)
- `packages/deepseek-harness/docs/DETAIL.md`

## Cross-cutting rules

- Treat the core/adapter boundary in the READMEs as immutable: core takes
  **bytes + explicit format**; paths, suffix detection, IO, sessions, and UI
  belong to the adapter. If a change needs those in core, it is in the wrong
  package.
- Use the official Mol* UI (`createPluginUI` + `DefaultPluginUISpec`); do not
  reintroduce the headless viewer, the `Viewer` wrapper, or a custom toolbar.
- Agent operations must go through `mol_*` tools. Shell/code is for calculations
  (interface geometry, H-bond candidates, builds), not for driving the viewer.
- Verify changes with `pnpm typecheck`, the package build, real fixtures, and
  the actual DSH page. A screenshot alone does not prove panel/layout behavior.
- Documentation defaults to English with a synchronized `README_zh.md`. Update
  the relevant READMEs when behavior or APIs change.
- npm packages contain **compiled JS and `.d.ts` only**, never `src/`, `AGENTS.md`,
  or build scripts. Use the package `files` allowlist; `lib/` is build output and
  stays out of git.
- Keep package changes scoped; read the package playbook, review the final diff,
  and commit separately.
