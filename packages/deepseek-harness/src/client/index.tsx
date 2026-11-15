/**
 * Client half of @gcszhn/mol4agent-deepseekharness.
 *
 * Registers the molecular document preview (the right-sidebar "open with"
 * candidate), its body, and the session header bridge. All path handling and
 * file reading stay in this adapter; the Mol* chunk loads lazily.
 *
 * @module @gcszhn/mol4agent-deepseekharness/client
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { BINARY_EXTENSIONS, PREVIEW_EXTENSIONS } from '../formats.ts'
import { MolBridge } from './bridge.tsx'
import { MolBody } from './document.tsx'
import { DICTIONARIES, NS, type MolTranslate } from './locale.ts'
import { disposeCachedViewers } from './viewer-cache.ts'

/** This implementation's id in DSH's document-preview registry. */
export const PREVIEW_ID = 'mol4agent/molstar'

/** Client services this plugin cannot activate without. */
export const inject = [
  'slots',
  'locale',
  'documentPreviews',
  'sidebarRight',
  'remote',
  'remote.workspaceFiles',
  'remote.commands',
  'theme',
]

/** Client activation entry. */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind(NS) as MolTranslate
  const theme = ctx.theme.getTheme().active.colorScheme

  ctx.effect(() => () => { disposeCachedViewers() }, 'mol4agent: viewer cache')

  ctx.effect(() => ctx.locale.register(NS, 'en', DICTIONARIES.en), 'mol4agent: en dictionary')
  ctx.effect(() => ctx.locale.register(NS, 'zh', DICTIONARIES.zh), 'mol4agent: zh dictionary')

  // The document-preview candidate. `priority: 'extension'` makes it the
  // default renderer for these suffixes; the existing text/code viewers stay
  // selectable through the preview's "open with" menu.
  ctx.effect(() => ctx.documentPreviews.register({
    id: PREVIEW_ID,
    extensions: PREVIEW_EXTENSIONS,
    binaryExtensions: BINARY_EXTENSIONS,
    priority: 'extension',
    title: () => t('viewer'),
    loading: 'renderer',
    wrap: false,
  }), 'mol4agent: document preview definition')

  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({
    name: 'sidebar.right.tab.document',
    key: PREVIEW_ID,
    inject: sessionId => ({
      theme,
      subscribeTheme: (listener: (next: 'light' | 'dark') => void): (() => void) => {
        listener(ctx.theme.getTheme().active.colorScheme)
        return ctx.on('theme/change', snapshot => { listener(snapshot.active.colorScheme) })
      },
      t,
      readBytes: async (path: string, signal: AbortSignal): Promise<Uint8Array> => {
        const result = await ctx.remote.workspaceFiles.readBytes(sessionId, path, {}, signal)
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
        return result.value.data
      },
      deliverCapture: async (callId: string, png: Uint8Array, report: Record<string, unknown>): Promise<void> => {
        const result = await ctx.remote.commands.execute(
          sessionId,
          `/mol4agent_capture ${callId}`,
          [{ type: 'image', mediaType: 'image/png', data: encodeBase64(png) }],
          new AbortController().signal,
        )
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      },
    }),
  }, MolBody)), 'mol4agent: document body')

  ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'mol4agent',
    order: 20,
    inject: () => ({
      t,
      openResource: (address: string): void => {
        ctx.sidebarRight.openResource(address, { destination: 'sidebar' })
      },
    }),
  }, MolBridge)), 'mol4agent: session bridge')
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}
