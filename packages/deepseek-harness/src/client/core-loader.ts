/**
 * Core loader. Mol* is bundled into the client module so the Desktop custom
 * protocol never has to fetch a separate lazy chunk.
 *
 * @module @gcszhn/mol4agent-deepseekharness/client/core-loader
 */
import { createMolViewer, type MolViewer } from '@gcszhn/mol4agent-core'

export interface MolViewerCore {
  createMolViewer(options: {
    container: HTMLElement
    theme?: 'light' | 'dark'
  }): Promise<MolViewer>
}

/** Resolve the bundled core. */
export function loadMolCore(): Promise<MolViewerCore> {
  return Promise.resolve({ createMolViewer })
}
