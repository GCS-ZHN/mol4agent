/**
 * Optional React binding. The host application supplies bytes; this component
 * only owns the viewer lifecycle.
 *
 * @module @gcszhn/mol4agent-core/react
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, type CSSProperties, type ReactNode } from 'react'
import type { MolCommand, StructureData } from './protocol.ts'
import { createMolViewer, type MolViewer } from './viewer.ts'

export interface Mol4AgentScene {
  readonly data: StructureData
  readonly commands: readonly MolCommand[]
}

export interface Mol4AgentViewerProps {
  /** Adapter-supplied bytes and commands. Memoize this object to avoid reloads. */
  readonly scene?: Mol4AgentScene
  readonly theme?: 'light' | 'dark'
  readonly className?: string
  readonly style?: CSSProperties
  /** Called once the viewer is ready, and with null when it is disposed. */
  readonly onViewer?: (viewer: MolViewer | null) => void
  readonly onError?: (error: unknown) => void
  /** Rendered above the canvas by the adapter (toolbars, banners). */
  readonly children?: ReactNode
}

export interface Mol4AgentViewerHandle {
  readonly viewer: MolViewer | null
}

export const Mol4AgentViewer = forwardRef<Mol4AgentViewerHandle, Mol4AgentViewerProps>(function Mol4AgentViewer(
  { scene, theme, className, style, onViewer, onError, children },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<MolViewer | null>(null)
  const generation = useRef(0)

  useImperativeHandle(ref, () => ({ get viewer() { return viewerRef.current } }), [])

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    let cancelled = false
    void createMolViewer({ container: host, theme, onError }).then(viewer => {
      if (cancelled) {
        viewer.dispose()
        return
      }
      viewerRef.current = viewer
      onViewer?.(viewer)
    }, error => {
      if (!cancelled) onError?.(error)
    })
    return () => {
      cancelled = true
      onViewer?.(null)
      viewerRef.current?.dispose()
      viewerRef.current = null
    }
  }, [theme, onViewer, onError])

  useEffect(() => {
    const viewer = viewerRef.current
    if (viewer === null || scene === undefined) return
    const current = ++generation.current
    void (async () => {
      await viewer.load(scene.data)
      if (current !== generation.current) return
      await viewer.apply(scene.commands)
    })().catch(error => {
      if (current === generation.current) onError?.(error)
    })
  }, [scene, onError])

  return (
    <div
      className={className}
      style={{ position: 'relative', width: '100%', height: '100%', ...style }}
    >
      <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
      {children}
    </div>
  )
})
