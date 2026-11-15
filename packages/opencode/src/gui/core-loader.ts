/**
 * A single lazy loader for `@gcszhn/mol4agent-core`.
 *
 * Both the agent panel and the file viewer dynamic-import core. A second
 * `import()` site makes Rollup inline core's (large) dependency graph — Mol*
 * and a Markdown pipeline — eagerly, and the Markdown entity decoder runs
 * `document.createElement` at module scope, which crashes the Electron main
 * process as the GUI bundle loads. One shared loader keeps core's chunk lazy.
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
