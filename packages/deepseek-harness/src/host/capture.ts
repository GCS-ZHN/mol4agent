/**
 * Pending screenshot requests: a tool blocks here while the browser renders
 * the viewport and delivers the image through a session command.
 *
 * @module @gcszhn/mol4agent-deepseekharness/host/capture
 */
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { PendingRequests } from './pending.ts'

/** One delivered capture: the admitted image plus the browser's diagnostic report. */
export interface CaptureDelivery {
  readonly ref: ImageAttachmentRef
  readonly report?: Record<string, unknown>
}

/** Session + tool-call keyed rendezvous for `mol_capture`. */
export class CaptureHub extends PendingRequests<CaptureDelivery> {
  constructor() {
    super('the molecular viewer did not deliver a screenshot in time; '
      + 'open the file preview for this structure and try again')
  }
}

/**
 * A filesystem-safe file name for a persisted capture.
 *
 * DSH attachment ids look like `sha256:7dc1…`. `:` is illegal in a Windows
 * file name, and `writeFile` does not fail there: it writes the PNG into an
 * NTFS alternate data stream, leaving the reported path a zero-byte file.
 * Keep only alphanumerics, and take the tail so the digest still identifies
 * the image. The `mol4agent-` prefix also keeps Windows device names away.
 */
export function captureFileName(attachmentId: unknown, timestamp: number): string {
  const safeId = String(attachmentId).replace(/[^a-zA-Z0-9]/gu, '')
  const suffix = safeId.slice(-12) || 'image'
  return `mol4agent-${String(timestamp)}-${suffix}.png`
}
