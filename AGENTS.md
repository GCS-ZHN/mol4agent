# AGENTS.md

Repository-level routing and product-level constraints for future agent
sessions. Read the package playbook before changing that package:

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

## Functional goals (all harnesses)

These are product acceptance goals, not package-specific implementation notes.
Specific implementation requirements live in the package playbooks.

1. **Structure preview is first-class.** Opening a supported molecular file in
   the harness previewer shows the official Mol* 3D UI by default, not plain
   text. The host's normal "open with" affordance still offers text/code.
2. **The agent operates the same page the human sees.** Opening, styling,
   selecting/highlighting, focusing, measuring, and capturing go through the
   adapter's agent tools. The human watches the page change; page-level code
   injection is not an agent interface.
3. **Agent-initiated open.** Naming a structure for an operation reveals or
   opens its preview without a separate manual click.
4. **Harness parity.** Every adapter exposes the same core semantics for
   `MolFormat`, selectors, commands, style targets, and capture. DSH and the
   future ChatGPT/Codex adapter may differ in transport, auth, and preview API,
   not in molecular behavior. Adapter-specific behavior belongs in that
   adapter's playbook/README and must not leak into core.
5. **Predictable UX.** Use the official Mol* UI and controls; follow the host
   light/dark theme; start with the official control panel set closed; preserve
   viewer state across document tabs; return captured PNGs (or an explicit saved
   path) through the tool result.
6. **Robust boundaries.** Core consumes bytes plus an explicit format; adapters
   own paths, suffix mapping, authorization, IO, sessions, and UI. Errors are
   structured and model-actionable; never dump a whole structure file as text.

## Cross-cutting constraints

- Treat the core/adapter boundary in the READMEs as immutable. If a change needs
  path detection, IO, or session state in core, it is in the wrong package.
- Use the official Mol* UI (`createPluginUI` + `DefaultPluginUISpec`); do not
  reintroduce the headless viewer, the `Viewer` wrapper, or a custom toolbar.
- Keep agent operations on `mol_*` tools. Shell/code is for calculations
  (interface geometry, H-bond candidates, builds), not for driving the viewer.
- A new selector/command/tool is a cross-package change: update core semantics,
  every adapter, the prompt, and the relevant READMEs in the same change.
- Verify with `pnpm typecheck`, the package build, real fixtures, and the actual
  harness page. A screenshot alone does not prove panel/layout behavior.
- Documentation defaults to English with a synchronized `README_zh.md`. Update
  the relevant READMEs when behavior or APIs change.
- npm packages contain **compiled JS and `.d.ts` only**, never `src/`, `AGENTS.md`,
  or build scripts. Use the package `files` allowlist; `lib/` is build output and
  stays out of git.
- Keep package changes scoped; read the package playbook, review the final diff,
  and commit separately.
