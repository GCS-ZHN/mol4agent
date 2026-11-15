/**
 * Internal UI→Host command used to deliver viewer screenshots.
 *
 * The browser calls `commands.execute` with a PNG attachment; the handler
 * resolves the tool call blocked in {@link CaptureHub}. It carries no visible
 * input (recordInput: false) and renders as a one-line command row.
 *
 * @module @gcszhn/mol4agent-deepseekharness/host/commands
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type { ImageBlock } from '@deepseek-ai/dsh-llm'
import type { CaptureHub } from './capture.ts'

/** Register `mol4agent_capture`. */
export function registerCaptureCommand(ctx: Context, hub: CaptureHub): void {
  ctx.commands.register({
    name: 'mol4agent_capture',
    description: 'Internal: deliver a molecular viewer screenshot to a waiting mol_capture call.',
    input: { attachments: true, hint: 'internal viewer capture' },
    recordInput: false,
    handler: invocation => {
      const [callId, encodedReport] = invocation.rawInput.trim().split(/\s+/u)
      if (callId === undefined || callId === '') return { kind: 'error', text: 'missing capture call id' }
      let report: Record<string, unknown> | undefined
      if (encodedReport !== undefined) {
        try {
          const parsed: unknown = JSON.parse(decodeURIComponent(encodedReport))
          if (typeof parsed === 'object' && parsed !== null) report = parsed as Record<string, unknown>
        } catch {
          report = undefined
        }
      }
      const image = invocation.attachments.find((block): block is ImageBlock => block.type === 'image')
      if (image === undefined) return { kind: 'error', text: 'no image attachment was submitted' }
      const delivered = hub.deliver(invocation.agent.id, callId, image.attachment, report)
      return delivered
        ? { kind: 'success' }
        : { kind: 'error', text: `no pending capture for ${callId}` }
    },
  })
}
