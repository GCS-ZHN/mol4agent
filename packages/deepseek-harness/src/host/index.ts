/**
 * Host half of @gcszhn/mol4agent-deepseekharness.
 *
 * Registers the `mol4agent` projection, the molecule tools, the internal
 * screenshot command, and the model-facing guidance. All file/path logic stays
 * in this adapter; the viewer core receives bytes plus an explicit format.
 *
 * @module @gcszhn/mol4agent-deepseekharness
 */
import type { Context } from '@deepseek-ai/cordis'
import { CaptureHub } from './capture.ts'
import { registerCaptureCommand } from './commands.ts'
import { MOL_PROMPT } from './prompt.ts'
import { molProjectionDefinition } from './projection.ts'
import { registerTools } from './tools.ts'

export const name = 'mol4agent'

/** Services this plugin cannot activate without. */
export const inject = ['tools', 'sessionProjections', 'systemPrompt', 'commands', 'workingDirectory', 'attachments']

/** Host activation entry. */
export async function apply(ctx: Context): Promise<void> {
  const hub = new CaptureHub()
  const projection = await ctx.sessionProjections.register(molProjectionDefinition())

  registerTools(ctx, {
    hub,
    sceneOf: (session, tab) => {
      const state = projection.stateOf(session)
      const key = tab ?? state.active
      return key === null ? undefined : state.tabs[key]
    },
    maxFileBytes: 64 * 1024 * 1024,
    captureTimeoutMs: 20_000,
    captureWidth: 1024,
    captureHeight: 768,
  })
  registerCaptureCommand(ctx, hub)

  ctx.systemPrompt.section({ name: 'mol4agent', order: 80, text: MOL_PROMPT })
  ctx.effect(() => () => { hub.dispose() }, 'mol4agent: capture hub')
}
