/**
 * Session-header bridge: opens the right-sidebar preview for each new agent
 * tab page, activates the tab targeted by a pending capture, and offers a chip
 * for the active tab.
 *
 * It is mounted outside the chat flow, so an agent command opens the page even
 * when the tool card is scrolled away.
 *
 * @module @gcszhn/mol4agent-deepseekharness/client/bridge
 */
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { MolSessionState } from '../state.ts'
import { sessionFileAddress } from './address.ts'

export interface MolBridgeInjected {
  readonly openResource: (address: string) => void
  readonly t: (key: string) => string
}

export type MolBridgeProps = PropsRuntime<'conversation.session.header.utilities'> & MolBridgeInjected

export function MolBridge(props: MolBridgeProps): ReactNode {
  const projection = props.useProjection('mol4agent') as MolSessionState | undefined
  const tabs = projection?.tabs
  const activePath = projection?.active
  const pending = projection?.pending
  // Existing projection entries are restored by the chip/capture path, not
  // auto-opened on Session mount. New or reopened tabs are opened as they land.
  const initialized = useRef(false)
  const opened = useRef(new Map<string, string>())

  useEffect(() => {
    if (tabs === undefined) return
    if (!initialized.current) {
      initialized.current = true
      for (const [path, scene] of Object.entries(tabs)) opened.current.set(path, scene.sceneKey)
      return
    }
    let newest: string | undefined
    for (const [path, scene] of Object.entries(tabs)) {
      if (opened.current.get(path) === scene.sceneKey) continue
      opened.current.set(path, scene.sceneKey)
      newest = path
    }
    if (newest !== undefined) props.openResource(sessionFileAddress(props.sessionId, newest))
  }, [tabs, props.openResource, props.sessionId])

  useEffect(() => {
    if (pending === undefined) return
    for (const request of Object.values(pending)) {
      if (request.path === undefined) continue
      props.openResource(sessionFileAddress(props.sessionId, request.path))
      break
    }
  }, [pending, props.openResource, props.sessionId])

  const active = activePath === null || activePath === undefined ? undefined : tabs?.[activePath]
  if (active === undefined) return null
  return (
    <button
      type="button"
      style={chipStyle}
      title={props.t('openViewer')}
      onClick={() => { props.openResource(sessionFileAddress(props.sessionId, active.path)) }}
    >
      <span style={dotStyle} aria-hidden="true" />
      {active.label}
    </button>
  )
}

const chipStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  maxWidth: 180,
  height: 24,
  padding: '0 8px',
  border: '0.5px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.35))',
  borderRadius: 6,
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary, inherit)',
  cursor: 'pointer',
  fontSize: 12,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const dotStyle: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: 3,
  background: 'var(--dsw-alias-brand-primary, #247bbf)',
  flex: '0 0 auto',
}
