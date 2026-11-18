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
import type { AlignmentResult, TmScoreResult } from '@gcszhn/mol4agent-core/protocol'
import type { AlignDelivery, AlignHub } from './align.ts'
import type { CaptureHub } from './capture.ts'
import type { InspectHub } from './inspect.ts'
import type { MolTmScoreAnswer } from '../state.ts'
import type { TmScoreHub } from './tm-score.ts'
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


/** Register `mol4agent_align_result` (browser → Host alignment metrics). */
export function registerAlignResultCommand(ctx: Context, hub: AlignHub): void {
  ctx.commands.register({
    name: 'mol4agent_align_result',
    description: 'Internal: report molecular alignment metrics to a waiting mol_align call.',
    input: { hint: 'internal alignment result' },
    recordInput: false,
    handler: invocation => {
      const [callId, encoded] = invocation.rawInput.trim().split(/\s+/u)
      if (callId === undefined || callId === '') return { kind: 'error', text: 'missing alignment call id' }
      if (encoded === undefined) return { kind: 'error', text: 'missing alignment result' }
      let parsed: unknown
      try {
        parsed = JSON.parse(decodeURIComponent(encoded))
      } catch {
        return { kind: 'error', text: 'invalid alignment result JSON' }
      }
      const delivery = parseDelivery(parsed)
      if (delivery === undefined) return { kind: 'error', text: 'invalid alignment result payload' }
      const delivered = hub.deliver(invocation.agent.id, callId, delivery)
      return delivered
        ? { kind: 'success' }
        : { kind: 'error', text: `no pending alignment for ${callId}` }
    },
  })
}

function parseDelivery(value: unknown): AlignDelivery | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as { ok?: unknown; data?: unknown; error?: unknown }
  if (candidate.ok === true) {
    const data = candidate.data
    if (typeof data !== 'object' || data === null) return undefined
    const result = data as Record<string, unknown>
    if (typeof result.rmsd !== 'number' || typeof result.alignedLength !== 'number') return undefined
    return { ok: true, result: data as AlignmentResult }
  }
  if (candidate.ok === false && typeof candidate.error === 'string' && candidate.error !== '') {
    return { ok: false, error: candidate.error }
  }
  return undefined
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


/** Register `mol4agent_tmscore_result` (browser → Host TM-score metrics). */
export function registerTmScoreCommand(ctx: Context, hub: TmScoreHub): void {
  ctx.commands.register({
    name: 'mol4agent_tmscore_result',
    description: 'Internal: report TM-score metrics to a waiting mol_tmscore call.',
    input: { hint: 'internal TM-score result' },
    recordInput: false,
    handler: invocation => {
      const [callId, encoded] = invocation.rawInput.trim().split(/\s+/u)
      if (callId === undefined || callId === '') return { kind: 'error', text: 'missing TM-score call id' }
      if (encoded === undefined) return { kind: 'error', text: 'missing TM-score result' }
      let parsed: unknown
      try {
        parsed = JSON.parse(decodeURIComponent(encoded))
      } catch {
        return { kind: 'error', text: 'invalid TM-score result JSON' }
      }
      const answer = parseTmScoreAnswer(parsed)
      if (answer === undefined) return { kind: 'error', text: 'invalid TM-score result payload' }
      return hub.deliver(invocation.agent.id, callId, answer)
        ? { kind: 'success' }
        : { kind: 'error', text: `no pending TM-score request for ${callId}` }
    },
  })
}

function parseTmScoreAnswer(value: unknown): MolTmScoreAnswer | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as { ok?: unknown; result?: unknown; message?: unknown }
  if (candidate.ok === true) {
    const result = candidate.result
    if (typeof result !== 'object' || result === null) return undefined
    const data = result as Record<string, unknown>
    if (typeof data.rmsd !== 'number' || typeof data.alignedLength !== 'number'
      || typeof data.tmScoreA !== 'number' || typeof data.tmScoreB !== 'number') return undefined
    return { ok: true, result: result as TmScoreResult }
  }
  if (candidate.ok === false && typeof candidate.message === 'string' && candidate.message !== '') {
    return { ok: false, message: candidate.message }
  }
  return undefined
}
