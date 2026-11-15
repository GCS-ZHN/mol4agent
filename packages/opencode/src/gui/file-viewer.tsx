/**
 * A `FileViewer` that renders a molecular structure when the file view would
 * otherwise show it as text.
 *
 * OpenCode's `artifactKind` classifies `.pdb`/`.cif`/`.sdf`/... as `"text"`
 * because they have no MIME entry, so the file view shows them as plain text.
 * Registering a viewer for the `"text"` kind lets it claim files whose bytes
 * look molecular (`problem` rejects everything else) and render core's official
 * Mol* UI instead.
 *
 * The host element is created imperatively rather than as JSX: vite-plugin-solid
 * hoists a JSX `<div>` into a module-scope `template()` call, and that runs in
 * the Electron main process (which has no `document`) as the GUI bundle loads.
 *
 * @module @gcszhn/mol4agent-opencode/file-viewer
 */
import { createEffect, onCleanup, type JSX } from 'solid-js'
import type { FileViewer, FileViewerProps } from '@opencode/plugin/gui/file'
import type { MolViewer } from '@gcszhn/mol4agent-core'
import { loadCore } from './core-loader.ts'
import { formatOfBytes } from './detect.ts'

function MolecularFileView(props: FileViewerProps & { readonly theme: () => 'light' | 'dark' }): JSX.Element {
  let viewer: MolViewer | undefined
  let loaded: Uint8Array | undefined
  let queue: Promise<void> = Promise.resolve()

  const host = document.createElement('div')
  host.style.cssText = 'width:100%;height:100%;min-height:320px;position:relative;overflow:hidden;'

  console.log('[mol4agent] FileViewer.View', props.bytes.byteLength)

  const sync = (bytes: Uint8Array): void => {
    queue = queue
      .then(async () => {
        const format = formatOfBytes(bytes)
        if (format === undefined) {
          props.onError('not a molecular structure')
          return
        }
        if (viewer === undefined) {
          const mod = await loadCore()
          viewer = await mod.createMolViewer({ container: host, theme: props.theme() })
        }
        if (bytes !== loaded) {
          await viewer.load({ data: bytes, format, label: 'structure' })
          loaded = bytes
          props.onDetails([format.toUpperCase()])
        }
      })
      .catch(reason => props.onError(reason instanceof Error ? reason.message : String(reason)))
  }

  createEffect(() => { sync(props.bytes) })
  createEffect(() => { viewer?.setTheme(props.theme()) })
  onCleanup(() => { viewer?.dispose(); viewer = undefined })

  return host
}

/** Build the `FileViewer` for `ctx.add(FileViewer, ...)`. */
export function createMolecularFileViewer(getTheme: () => 'light' | 'dark'): FileViewer {
  return {
    kinds: ['text'],
    problem(bytes) {
      const format = formatOfBytes(bytes)
      console.log('[mol4agent] FileViewer.problem', bytes.byteLength, format)
      return format === undefined ? 'not a molecular structure' : undefined
    },
    View: (props: FileViewerProps) => MolecularFileView({ ...props, theme: getTheme }),
  }
}
