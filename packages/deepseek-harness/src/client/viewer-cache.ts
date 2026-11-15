/**
 * Live viewer cache across document-tab switches.
 *
 * The right-sidebar tab system unmounts an inactive document body. Rebuilding
 * Mol* and re-reading the file on every switch is both slow and loses camera /
 * representation state, so an unmounted body parks its whole viewer container
 * in a detached holder and the next mount of the same tab reattaches it.
 *
 * @module @gcszhn/mol4agent-deepseekharness/client/viewer-cache
 */
import type { MolViewer } from '@gcszhn/mol4agent-core'

export interface CachedViewerMark {
  revision: number
  version: string | undefined
  sceneKey: string | undefined
  applied: number
}

export interface CachedViewer {
  readonly viewer: MolViewer
  readonly mount: HTMLElement
  readonly mark: CachedViewerMark
}

/** Most recent tabs kept alive; Mol* viewers are heavy. */
const MAX_CACHED = 2

const cache = new Map<string, CachedViewer>()
let holder: HTMLDivElement | undefined

function hiddenHolder(): HTMLDivElement {
  holder ??= (() => {
    const element = document.createElement('div')
    element.style.cssText = 'position:absolute;left:-99999px;top:0;width:1px;height:1px;overflow:hidden;'
    return element
  })()
  return holder
}

/** Take a cached viewer out of the cache (the caller becomes its owner). */
export function takeCachedViewer(key: string): CachedViewer | undefined {
  const entry = cache.get(key)
  if (entry === undefined) return undefined
  cache.delete(key)
  return entry
}

/** Park a viewer for a later mount, evicting the oldest when full. */
export function putCachedViewer(key: string, entry: CachedViewer): void {
  const existing = cache.get(key)
  if (existing !== undefined) disposeEntry(existing)
  hiddenHolder().appendChild(entry.mount)
  cache.set(key, entry)
  while (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next()
    if (oldest.done === true) break
    const evicted = cache.get(oldest.value)
    if (evicted === undefined) {
      cache.delete(oldest.value)
      continue
    }
    cache.delete(oldest.value)
    disposeEntry(evicted)
  }
}

/** Drop every parked viewer; the plugin unload path. */
export function disposeCachedViewers(): void {
  for (const entry of cache.values()) disposeEntry(entry)
  cache.clear()
  holder?.remove()
  holder = undefined
}

function disposeEntry(entry: CachedViewer): void {
  entry.viewer.dispose()
  entry.mount.remove()
}
