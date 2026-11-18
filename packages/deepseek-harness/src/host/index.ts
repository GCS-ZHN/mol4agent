/**
 * Host half of @gcszhn/mol4agent-deepseekharness.
 *
 * Registers the `mol4agent` projection, the molecule tools, the internal
 * viewer commands, and the model-facing guidance. All file/path logic stays in
 * this adapter; the viewer core receives bytes plus an explicit format.
 *
 * @module @gcszhn/mol4agent-deepseekharness
 */
import type { Context } from '@deepseek-ai/cordis'
import { canonicalTabPath } from '../tab-path.ts'
import { AlignHub } from './align.ts'
import { CaptureHub } from './capture.ts'
import { registerAlignResultCommand, registerCaptureCommand, registerInspectCommand, registerTmScoreCommand } from './commands.ts'
import { InspectHub } from './inspect.ts'
import { TmScoreHub } from './tm-score.ts'
import { MOL_PROMPT } from './prompt.ts'
import { molProjectionDefinition } from './projection.ts'
import { registerTools } from './tools.ts'

export const name = 'mol4agent'

/** Services this plugin cannot activate without. */
export const inject = ['tools', 'sessionProjections', 'systemPrompt', 'commands', 'workingDirectory', 'attachments']

/** Host activation entry. */
export async function apply(ctx: Context): Promise<void> {
  const hub = new CaptureHub()
  const alignHub = new AlignHub()
  const tmScoreHub = new TmScoreHub()
  const inspectHub = new InspectHub()
  const projection = await ctx.sessionProjections.register(molProjectionDefinition())

  registerTools(ctx, {
    hub,
    alignHub,
    alignTimeoutMs: 15_000,
    tmScoreHub,
    tmScoreTimeoutMs: 15_000,
    inspectHub,
    sceneOf: (session, tab) => {
      const state = projection.stateOf(session)
      const key = tab === undefined ? state.active : canonicalTabPath(tab)
      return key === null ? undefined : state.tabs[key]
    },
    maxFileBytes: 64 * 1024 * 1024,
    fetchTimeoutMs: 30_000,
    captureTimeoutMs: 20_000,
    captureWidth: 1024,
    captureHeight: 768,
    inspectTimeoutMs: 20_000,
  })
  registerCaptureCommand(ctx, hub)
  registerAlignResultCommand(ctx, alignHub)
  registerTmScoreCommand(ctx, tmScoreHub)
  registerInspectCommand(ctx, inspectHub)

  ctx.systemPrompt.section({ name: 'mol4agent', order: 80, text: MOL_PROMPT })
  ctx.effect(() => () => {
    hub.dispose()
    alignHub.dispose()
    tmScoreHub.dispose()
    inspectHub.dispose()
  }, 'mol4agent: viewer request hubs')
}
