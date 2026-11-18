/**
 * Pending inspection queries: `mol_inspect` blocks here while the browser reads
 * its live Mol* state and delivers the answer through a session command.
 *
 * The browser may also report a failure (for example no structure is loaded in
 * that tab page), which is a normal tool result rather than a timeout.
 *
 * @module @gcszhn/mol4agent-deepseekharness/host/inspect
 */
import type { MolInspectAnswer } from '../state.ts'
import { PendingRequests } from './pending.ts'

/** Session + tool-call keyed rendezvous for `mol_inspect`. */
export class InspectHub extends PendingRequests<MolInspectAnswer> {
  constructor() {
    super('the molecular viewer did not answer the query in time; '
      + 'open the file preview for this structure and try again')
  }
}
