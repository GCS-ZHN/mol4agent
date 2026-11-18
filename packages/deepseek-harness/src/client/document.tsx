/**
 * The right-sidebar document body for molecular files.
 *
 * DSH's document preview hands us a `dsh-resource://file/session/<id>/<path>`
 * address. This adapter reads the bytes through its own Remote, then hands the
 * core bytes plus an explicit format. Mol*'s own UI supplies the controls; this
 * module owns only the viewer lifecycle, the projection follower, and capture
 * delivery.
 *
 * @module @gcszhn/mol4agent-deepseekharness/client/document
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { DocumentPreviewProps } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type { MolFormat, MolViewer } from '@gcszhn/mol4agent-core'
import { baseNameOf, formatOfFile, isGzipFile } from '../formats.ts'
import type { MolInspectAnswer, MolPendingCapture, MolSessionState } from '../state.ts'
import { canonicalTabPath } from '../tab-path.ts'
import { sessionPathOf } from './address.ts'
import { captureVisible } from './capture.ts'
import { loadMolCore } from './core-loader.ts'
import { gunzipBytes } from './gzip.ts'
import { putCachedViewer, takeCachedViewer } from './viewer-cache.ts'

/** Services and copy injected by the plugin's slot registration. */
export interface MolBodyInjected {
  readonly readBytes: (path: string, signal: AbortSignal) => Promise<Uint8Array>
  readonly deliverCapture: (callId: string, png: Uint8Array, report: Record<string, unknown>) => Promise<void>
  readonly deliverInspect: (callId: string, answer: MolInspectAnswer) => Promise<void>
  readonly theme: 'light' | 'dark'
  readonly subscribeTheme: (listener: (theme: 'light' | 'dark') => void) => () => void
  readonly t: (key: string) => string
}

export type MolBodyProps = DocumentPreviewProps & MolBodyInjected

interface LatestState {
  readonly path: string
  readonly format: MolFormat | undefined
  readonly version: string | undefined
  readonly revision: number
  readonly signal: AbortSignal
  readonly content: DocumentPreviewProps['content']
  readonly resourceAddress: string
  readonly readBytes: MolBodyInjected['readBytes']
  readonly addResource: (address: string) => void
}

interface LoadedMark {
  revision: number
  version: string | undefined
  sceneKey: string | undefined
  applied: number
}

const EMPTY_MARK: LoadedMark = { revision: -1, version: undefined, sceneKey: undefined, applied: 0 }

const MAX_PREVIEW_BYTES = 64 * 1024 * 1024

export function MolBody(props: MolBodyProps): ReactNode {
  const { tab } = props.useTabInfo()
  const meta = props.useResource<'file'>(props.resourceAddress)
  const projection = props.useProjection('mol4agent') as MolSessionState | undefined
  // The resource address is the only path spelling DSH guarantees on every
  // platform; canonicalize it to the same `/` form the Host projection keys.
  const path = useMemo(() => canonicalTabPath(sessionPathOf(props.resourceAddress) ?? ''), [props.resourceAddress])
  const format = useMemo(() => (path === '' ? undefined : formatOfFile(path)), [path])
  const version = meta.value?.version
  const revision = props.content.kind === 'renderer' ? props.content.revision : -1
  const cacheKey = `${String(props.sessionId)}:${String(tab.id)}:${path}`

  const hostRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<MolViewer>()
  const busy = useRef(false)
  const pendingReload = useRef(false)
  const loaded = useRef<LoadedMark>(EMPTY_MARK)
  const handledCaptures = useRef(new Set<string>())
  const handledInspections = useRef(new Set<string>())
  const applyFailures = useRef<string[]>([])
  const applyChain = useRef<Promise<void>>(Promise.resolve())
  const tRef = useRef(props.t)
  tRef.current = props.t
  const themeRef = useRef(props.theme)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string>()
  const [readyTick, setReadyTick] = useState(0)

  const current = useRef<LatestState>({
    path,
    format,
    version,
    revision,
    signal: tab.signal,
    content: props.content,
    resourceAddress: props.resourceAddress,
    readBytes: props.readBytes,
    addResource: props.addResource,
  })
  current.current = {
    path,
    format,
    version,
    revision,
    signal: tab.signal,
    content: props.content,
    resourceAddress: props.resourceAddress,
    readBytes: props.readBytes,
    addResource: props.addResource,
  }

  const reload = useCallback(async (): Promise<void> => {
    const viewer = viewerRef.current
    const latest = current.current
    if (viewer === undefined) return
    if (latest.path === '' || latest.format === undefined) {
      setError(tRef.current('unsupported'))
      setStatus('error')
      return
    }
    if (busy.current) {
      pendingReload.current = true
      return
    }
    busy.current = true
    setStatus('loading')
    setError(undefined)
    try {
      const raw = await latest.readBytes(latest.path, latest.signal)
      if (viewerRef.current !== viewer) return
      const bytes = isGzipFile(latest.path) ? await gunzipBytes(raw, MAX_PREVIEW_BYTES) : raw
      await viewer.load({ data: bytes, format: latest.format, label: baseNameOf(latest.path) })
      latest.addResource(latest.resourceAddress)
      if (latest.content.kind === 'renderer') latest.content.loaded(latest.version ?? 'unknown')
      loaded.current = { revision: latest.revision, version: latest.version, sceneKey: undefined, applied: 0 }
      setStatus('ready')
      setReadyTick(tick => tick + 1)
    } catch (reason) {
      if (latest.content.kind === 'renderer') latest.content.failed()
      setError(reason instanceof Error ? reason.message : String(reason))
      setStatus('error')
    } finally {
      busy.current = false
      if (pendingReload.current) {
        pendingReload.current = false
        void reload()
      }
    }
  }, [])

  // One viewer per document tab. Recreating it on every render (or every
  // locale/inject identity) used to dispose a loaded viewer and leave the
  // current one empty, so this effect only depends on the tab identity.
  useEffect(() => props.subscribeTheme(theme => {
    themeRef.current = theme
    viewerRef.current?.setTheme(theme)
  }), [props.subscribeTheme])

  useEffect(() => {
    const placeholder = hostRef.current
    if (placeholder === null) return
    if (path === '' || format === undefined) {
      setError(tRef.current('unsupported'))
      setStatus('error')
      return
    }

    // A tab switch unmounts this body. Reattach the parked viewer instead of
    // rebuilding Mol* and re-reading the file, so camera/representations/UI
    // panel state survive the switch.
    const cached = takeCachedViewer(cacheKey)
    if (cached !== undefined) {
      placeholder.appendChild(cached.mount)
      viewerRef.current = cached.viewer
      loaded.current = cached.mark
      cached.viewer.setTheme(themeRef.current)
      cached.viewer.resize()
      if (props.content.kind === 'renderer') props.content.loaded(cached.mark.version ?? 'unknown')
      setStatus('ready')
      setError(undefined)
      return () => {
        if (viewerRef.current !== cached.viewer) return
        viewerRef.current = undefined
        putCachedViewer(cacheKey, { viewer: cached.viewer, mount: cached.mount, mark: loaded.current })
      }
    }

    const mount = document.createElement('div')
    mount.style.cssText = 'position:absolute;inset:0;'
    placeholder.appendChild(mount)
    let cancelled = false
    let created: MolViewer | undefined
    loaded.current = EMPTY_MARK
    setStatus('loading')
    setError(undefined)
    void (async () => {
      try {
        const core = await loadMolCore()
        if (cancelled) return
        created = await core.createMolViewer({ container: mount, theme: themeRef.current })
        if (cancelled) {
          created.dispose()
          mount.remove()
          return
        }
        viewerRef.current = created
        await reload()
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason))
          setStatus('error')
        }
      }
    })()
    return () => {
      cancelled = true
      const viewer = viewerRef.current
      if (viewerRef.current === created) viewerRef.current = undefined
      if (viewer !== undefined && viewer === created) {
        putCachedViewer(cacheKey, { viewer, mount, mark: loaded.current })
      } else {
        mount.remove()
      }
    }
  }, [cacheKey, path, format, reload])

  useEffect(() => {
    if (viewerRef.current === undefined) return
    if (loaded.current.revision === revision && loaded.current.version === version) return
    void reload()
  }, [revision, version, reload])

  const scene = path === '' ? undefined : projection?.tabs?.[path]
  useEffect(() => {
    const viewer = viewerRef.current
    if (viewer === undefined || scene === null || scene === undefined) return
    if (scene.path !== path) return
    if (loaded.current.revision === -1) return
    applyChain.current = applyChain.current
      .then(async () => {
        if (loaded.current.sceneKey !== scene.sceneKey) {
          const firstScene = loaded.current.sceneKey === undefined
          loaded.current.sceneKey = scene.sceneKey
          loaded.current.applied = 0
          applyFailures.current = []
          // A new scene is a fresh open: reload the bytes so old measurements,
          // selection components, and styles do not leak into the new scene.
          // The first scene after a viewer mount is already loaded, so skip it.
          if (!firstScene) {
            await reload()
            loaded.current.sceneKey = scene.sceneKey
            loaded.current.applied = 0
          }
        }
        for (let index = loaded.current.applied; index < scene.commands.length; index += 1) {
          const command = scene.commands[index]
          if (command === undefined) continue
          const result = await viewer.execute(command)
          if (!result.ok) {
            applyFailures.current.push(`${command.op}: ${result.message}`)
            console.warn('[mol4agent]', result.message)
          }
        }
        loaded.current.applied = scene.commands.length
        const diagnostics = viewer.diagnostics?.()
        if (diagnostics !== undefined && diagnostics.representations === 0) {
          const fallback = await viewer.execute({ op: 'represent', style: { type: 'cartoon', color: 'chain-id' } })
          if (!fallback.ok) {
            applyFailures.current.push(`fallback represent: ${fallback.message}`)
            console.warn('[mol4agent] fallback representation failed', fallback.message)
          }
        }
      })
      .catch(reason => { console.warn('[mol4agent] scene apply failed', reason) })
  }, [scene, path, readyTick])

  const pending = projection?.pending as Readonly<Record<string, MolPendingCapture>> | undefined
  useEffect(() => {
    const viewer = viewerRef.current
    if (viewer === undefined || status !== 'ready' || pending === undefined) return
    if (scene === null || scene === undefined || scene.path !== path) return
    for (const [callId, request] of Object.entries(pending)) {
      if (handledCaptures.current.has(callId)) continue
      if (request.path !== undefined && request.path !== path) continue
      handledCaptures.current.add(callId)
      void (async () => {
        try {
          await applyChain.current
          const capture = await captureVisible(viewer, {
            width: request.width,
            height: request.height,
            transparent: request.transparent,
          })
          const report: Record<string, unknown> = {
            status,
            error: error ?? null,
            path,
            scenePath: scene.path,
            applied: loaded.current.applied,
            commands: scene.commands.length,
            visibleContent: capture.visible,
            ...(applyFailures.current.length === 0 ? {} : { applyErrors: [...applyFailures.current] }),
            ...(viewer.diagnostics?.() ?? {}),
          }
          await props.deliverCapture(callId, capture.png, report)
        } catch (reason) {
          console.warn('[mol4agent] screenshot failed', reason)
        }
      })()
    }
  }, [pending, scene, status, path, error, props.deliverCapture])

  const inspecting = projection?.inspecting
  useEffect(() => {
    const viewer = viewerRef.current
    if (viewer === undefined || status !== 'ready' || inspecting === undefined) return
    if (scene === null || scene === undefined || scene.path !== path) return
    for (const [callId, request] of Object.entries(inspecting)) {
      if (handledInspections.current.has(callId)) continue
      if (request.path !== undefined && request.path !== path) continue
      handledInspections.current.add(callId)
      void (async () => {
        // Answer from the scene the surface would show, not a half-applied one.
        await applyChain.current
        const answer: MolInspectAnswer = (() => {
          try {
            const result = viewer.inspect({
              ...(request.target === undefined ? {} : { target: request.target }),
              ...(request.detail === undefined ? {} : { detail: request.detail }),
              ...(request.limit === undefined ? {} : { limit: request.limit }),
            })
            return { ok: true, result }
          } catch (reason) {
            return { ok: false, message: reason instanceof Error ? reason.message : String(reason) }
          }
        })()
        await props.deliverInspect(callId, answer)
      })().catch(reason => { console.warn('[mol4agent] inspection delivery failed', reason) })
    }
  }, [inspecting, scene, status, path, props.deliverInspect])

  return (
    <div style={rootStyle}>
      <div ref={hostRef} style={canvasStyle} />
      {status === 'error' && (
        <div style={overlayStyle}>
          <p style={overlayTitle}>{props.t('failed')}</p>
          {error !== undefined && <p style={errorText}>{error}</p>}
          <button type="button" style={retryButton} onClick={() => { void reload() }}>
            {props.t('retry')}
          </button>
        </div>
      )}
    </div>
  )
}

const rootStyle: CSSProperties = {
  position: 'relative',
  flex: '1 1 auto',
  minWidth: 0,
  minHeight: 0,
  height: '100%',
  overflow: 'hidden',
  background: 'var(--dsw-alias-bg-document-preview, transparent)',
}

const canvasStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
}

const overlayStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  zIndex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  padding: 24,
  textAlign: 'center',
  color: 'var(--dsw-alias-label-secondary, inherit)',
  background: 'var(--dsw-alias-bg-document-preview, transparent)',
}

const overlayTitle: CSSProperties = { margin: 0, fontSize: 13 }
const errorText: CSSProperties = { margin: 0, fontSize: 12, opacity: 0.8, wordBreak: 'break-word' }
const retryButton: CSSProperties = { padding: '4px 12px', borderRadius: 6, cursor: 'pointer' }
