# AGENTS.md — ChatGPT/Codex adapter

Read the [ChatGPT README](README.md) for the tool/API reference and the root
[`AGENTS.md`](../../AGENTS.md) for cross-cutting constraints. This file records
adapter-only invariants and traps.

This adapter must satisfy the product goals in
[`docs/architecture.md`](../../docs/architecture.md) §1.3, including R1 through
Codex's MCP extension file viewer.

## Server / app split

- `src/server.ts` + `src/tools.ts` are the only code that sees paths, chooses a
  `MolFormat`, reads bytes, writes captures, or stores scene state. Core receives
  `{ data, format, label }` only.
- `mol_fetch` follows the same split: core `sources` validates the entry id and
  returns a download plan, while `src/fetch.ts` performs the HTTPS download and
  the atomic workspace write. It creates no scene; the caller runs `mol_open`
  on the returned path.
- The app (`src/client/`) owns Mol* and WebGL. It must not read files, import
  Node modules, or infer formats.
- Mutating tools append JSON commands to `SceneStore` and wake the app's
  `mol_viewer_poll`; never push WebGL objects or bytes into scene commands.
- Keep scene isolation: `mol_open`/`mol_style`/... target the **active agent
  scene**; `mol_view_file` creates an independent **file** scene and never
  replaces the agent scene. Each app binds to its initial `sceneId`, ignores
  scenes with another id, and polls with its own mode (`agent`/`file`). Never
  let a new `mol_open` hijack an older tab.
- `mol_capture` is a plain tool with **no** viewer `_meta`: the already-mounted
  agent tab claims the pending capture through its normal long poll. Adding a
  UI template mounts a second viewer per screenshot and resets the camera.
  File tabs must not claim agent captures. `mol_viewer_poll` still accepts
  `mode: "capture"` for older app instances, but no current page uses it.
- A new model-facing tool is a cross-package change: update core semantics if
  needed, the DSH adapter and prompt, this adapter, and every relevant README in
  the same change. Transport-only app tools (`mol_viewer_poll`,
  `mol_capture_deliver`, `mol_capture_fail`) stay adapter-internal and
  `_meta.ui.visibility: ["app"]`.
- `mol_view_file` is the file-tree entrypoint. Its `_meta["openai/ui"]` must
  contain `entrypoints: [{ type: "file", extensions: [...] }]`, plus
  `_meta.ui.resourceUri` and `openai/outputTemplate`. The host calls it with
  `{ file: { name, resourceUri } }`; keep that contract instead of `path`.
- Gzip is adapter transport: recognize the `.gz` variant, decode on the server
  before storing scene bytes, cap the decompressed size with `maxFileBytes`,
  and list the gzip suffixes in the file-viewer entrypoint. Only a raw
  host-resource fallback is decoded again by the app (`DecompressionStream`);
  scene snapshots mark it with `fileGzip`.

## Distribution

- Codex installs plugins through Git marketplaces, not npm. The repository root
  `.agents/plugins/marketplace.json` is the public entrypoint and points the
  `mol4agent` plugin at the generated `plugin-dist` branch.
- `plugin-dist` is a build-output branch published by the release workflow
  (`.github/workflows/release.yml`) when `packages/chatgpt/package.json` changes
  version on `main`; it contains
  `plugins/mol4agent/{lib,skills,.codex-plugin,.mcp.json,...}`. Never commit
  `lib/` on source branches or edit `plugin-dist` by hand.
- Keep the marketplace name (`mol4agent-github`), plugin name (`mol4agent`), and
  Git source path/ref in sync with the README install commands.

## MCP App UI

- Serve the viewer at `ui://mol4agent/viewer.html` with MIME
  `text/html;profile=mcp-app`; `mol_open` advertises it with
  `_meta.ui.resourceUri`. Keep the HTML self-contained (no external chunks or
  CSP domains).
- Register `toolresult` / `hostcontextchanged` handlers before `app.connect()`;
  the host can fire one-shot notifications immediately after initialization.
- Every tool result that the app may see must carry a **full** scene snapshot
  (`sceneId`, `revision`, label, format, cumulative commands). A newly mounted
  card must be able to rebuild the current picture without earlier tool results.
- Agent-opened scenes load bytes through `mol4agent://structure/{sceneId}`.
  File-viewer scenes resolve the tool-call path, republish the bytes on the same
  `mol4agent://structure/{sceneId}` resource, and only fall back to the
  host-provided `fileResourceUri`. Do not put base64 in tool results; it would
  leak into model context.
- Use a short timer (not `requestAnimationFrame`) before `viewer.capture()`;
  headless hosts can throttle rAF and hang the capture.

## Capture rendezvous

- `mol_capture` enqueues a `PendingCapture` and blocks; the app claims it from
  the long poll, renders, and commits with `mol_capture_deliver`. Do not replace
  this with file polling or a second HTTP server.
- The claiming page is the agent tab opened by `mol_open`, so the capture uses
  the camera pose the human is looking at. Only `mol_open` / `mol_view_file`
  advertise the viewer resource; `mol_capture` returns an image block instead.
- The app must call `mol_capture_fail` on a render/readback error so the tool
  rejects promptly instead of waiting for the timeout.
- Validate the PNG signature and size on the server before saving. Captures go
  under `<workspace>/.mol4agent/captures/` and must never be committed.

## Build and packaging

- `pnpm --filter @gcszhn/mol4agent-chatgpt build` produces
  `lib/viewer.html` and `lib/server.js`; `lib/` stays out of git.
- Bundle **one React copy** into the app. Core may resolve a different Mol*
  instance with another React peer; the build aliases `react` and `react-dom`
  to this package's copies. Do not remove those aliases without checking the
  browser console for duplicate-React errors.
- The viewer is inlined with a replacer **function**; a replacement string would
  interpret `$&`/`$'` in the minified bundle and corrupt the script.
- `.codex-plugin/plugin.json` points at `.mcp.json` and `skills/`. The repo
  `.mcp.json` stays relative; `scripts/install-local.mjs` writes an absolute-path
  copy into the local marketplace because plugin cache locations vary.
- `files` is an allowlist for compiled output, skills, the plugin manifest,
  READMEs, and the icon. Do not include `src/`, `test/`, `AGENTS.md`, or build
  scripts in a packed artifact.

## Verification

- Run `pnpm typecheck`, the package build, and `node --test test/*.test.mjs`.
- The UI smoke test must load the real viewer in headless Chrome + SwiftShader,
  use the official `AppBridge`, and produce a non-trivial 1ATP PNG. Do not
  replace it with a DOM-only assertion.
- Verify the installed plugin in a real ChatGPT/Codex conversation: `mol_open`
  shows the card, `mol_style`/`mol_select` update it, and `mol_capture` returns
  an image. Also open a `.pdb` from the file tree, accept the per-extension
  prompt, and confirm the structure opens in the side panel while **Open with**
  still offers the built-in text viewer. A protocol test alone does not prove
  the host renders the MCP App.
