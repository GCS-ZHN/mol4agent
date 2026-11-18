/**
 * Internal UI→Host commands used to answer a tool that is parked in a hub.
 *
 * The browser calls `commands.execute`; the handler resolves the blocked tool
 * call. They carry no visible input (recordInput: false) and render as a
 * one-line command row.
 *
 * @module @gcszhn/mol4agent-deepseekharness/host/commands
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type { ImageBlock } from '@deepseek-ai/dsh-llm'
import type { CaptureHub } from './capture.ts'
import type { InspectHub } from './inspect.ts'
import { decodeInspectPayload } from './inspect-payload.ts'

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
      const delivered = hub.deliver(invocation.agent.id, callId, { ref: image.attachment, report })
      return delivered
        ? { kind: 'success' }
        : { kind: 'error', text: `no pending capture for ${callId}` }
    },
  })
}

/**
 * Register `mol4agent_inspect`.
 *
 * The browser submits the gzip+base64 answer as one token; it resolves a
 * waiting `mol_inspect` call with either a result or a failure message.
 */
export function registerInspectCommand(ctx: Context, hub: InspectHub): void {
  ctx.commands.register({
    name: 'mol4agent_inspect',
    description: 'Internal: answer a waiting mol_inspect call from the molecular viewer.',
    input: { hint: 'internal viewer inspection' },
    recordInput: false,
    handler: invocation => {
      const [callId, encoded] = invocation.rawInput.trim().split(/\s+/u)
      if (callId === undefined || callId === '') return { kind: 'error', text: 'missing inspect call id' }
      if (encoded === undefined) return { kind: 'error', text: 'missing inspect payload' }
      const answer = decodeInspectPayload(encoded)
      if (answer === undefined) return { kind: 'error', text: 'inspect payload could not be decoded' }
      return hub.deliver(invocation.agent.id, callId, answer)
        ? { kind: 'success' }
        : { kind: 'error', text: `no pending inspection for ${callId}` }
    },
  })
}
