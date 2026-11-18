/**
 * Pending alignment requests: a tool blocks here while the browser runs
 * `viewer.execute({ op: 'align' })` and reports RMSD/TM-score back through a
 * session command.
 *
 * @module @gcszhn/mol4agent-deepseekharness/host/align
 */
import type { AlignmentResult } from '@gcszhn/mol4agent-core/protocol'
import { PendingRequests } from './pending.ts'

export type AlignDelivery =
  | { readonly ok: true; readonly result: AlignmentResult }
  | { readonly ok: false; readonly error: string }

/** Session + tool-call keyed rendezvous for `mol_align`. */
export class AlignHub extends PendingRequests<AlignDelivery> {
  constructor() {
    super('the molecular viewer did not report alignment metrics in time; '
      + 'open the file preview for this structure and try again')
  }
}
