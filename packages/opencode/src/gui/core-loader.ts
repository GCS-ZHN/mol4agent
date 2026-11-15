/**
 * A single lazy loader for `@gcszhn/mol4agent-core`.
 *
 * Core (with Mol* and a Markdown pipeline) must stay out of the eager GUI
 * bundle: the Markdown entity decoder runs `document.createElement` at module
 * scope, which crashes the Electron main process when the GUI loads there.
 * Keep one shared dynamic `import()` site; a second entry point, or a bundler
 * that cannot split the chunk, can pull core's dependency graph in eagerly.
 * The esbuild GUI build keeps this chunk lazy.
 *
 * @module @gcszhn/mol4agent-opencode/core-loader
 */
type CoreModule = typeof import('@gcszhn/mol4agent-core')

let corePromise: Promise<CoreModule> | undefined

/** Lazily import core (and Mol* / React with it) exactly once. */
export function loadCore(): Promise<CoreModule> {
  corePromise ??= import('@gcszhn/mol4agent-core')
  return corePromise
}
