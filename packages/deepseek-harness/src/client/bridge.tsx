/**
 * Session-header bridge: opens the right-sidebar preview whenever the agent
 * targets a new structure, and offers a chip to reopen the current scene.
 *
 * It is session-scoped and mounted outside the chat flow, so an agent command
 * opens the page even when the tool card is scrolled away.
 *
 * @module @gcszhn/mol4agent-deepseekharness/client/bridge
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { sessionFileAddress } from './address.ts'

export interface MolBridgeInjected {
  readonly openResource: (address: string) => void
  readonly t: (key: string) => string
}

export type MolBridgeProps = PropsRuntime<'conversation.session.header.utilities'> & MolBridgeInjected

export function MolBridge(props: MolBridgeProps): ReactNode {
  const projection = props.useProjection('mol4agent')
  const scene = projection?.scene
  // A scene that already existed when this Session was opened is restored by
  // the chip, not auto-opened: switching Sessions should not steal the column.
  const [initialSceneKey] = useState(() => scene?.sceneKey)
  const opened = useRef<string | undefined>(initialSceneKey)

  useEffect(() => {
    if (scene === null || scene === undefined) return
    if (opened.current === scene.sceneKey) return
    opened.current = scene.sceneKey
    props.openResource(sessionFileAddress(props.sessionId, scene.path))
  }, [scene, props.openResource, props.sessionId])

  if (scene === null || scene === undefined) return null
  return (
    <button
      type="button"
      style={chipStyle}
      title={props.t('openViewer')}
      onClick={() => { props.openResource(sessionFileAddress(props.sessionId, scene.path)) }}
    >
      <span style={dotStyle} aria-hidden="true" />
      {scene.label}
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
