/**
 * Pending TM-score calculations: a tool blocks here while the browser compares
 * two live selections with Mol* and reports the metrics through a session command.
 *
 * @module @gcszhn/mol4agent-deepseekharness/host/tm-score
 */
import type { MolTmScoreAnswer } from '../state.ts'
import { PendingRequests } from './pending.ts'

/** Session + tool-call keyed rendezvous for `mol_tmscore`. */
export class TmScoreHub extends PendingRequests<MolTmScoreAnswer> {
  constructor() {
    super('the molecular viewer did not report TM-score metrics in time; '
      + 'open the file preview for this structure and try again')
  }
}
