/**
 * Mol* viewer with the official Mol* UI.
 *
 * The adapter supplies a container and already-resolved bytes plus an explicit
 * format. Core mounts Mol*'s own `Viewer` (its React UI, viewport controls and
 * stylesheet), loads the structure, and exposes the agent command API. There is
 * deliberately no path, reader, or filesystem hook here.
 *
 * @module @gcszhn/mol4agent-core/viewer
 */
import { createPluginUI } from 'molstar/lib/mol-plugin-ui'
import { renderReact18 } from 'molstar/lib/mol-plugin-ui/react18'
import { DefaultPluginUISpec } from 'molstar/lib/mol-plugin-ui/spec'
import { PluginConfig } from 'molstar/lib/mol-plugin/config'
import type { PluginContext } from 'molstar/lib/mol-plugin/context'
import { applyStructureInteractivity } from 'molstar/lib/extensions/plugin/interactivity'
import { StateSelection, StateTransform } from 'molstar/lib/mol-state'
import { MeasurementGroupTag } from 'molstar/lib/mol-plugin-state/manager/structure/measurement'
import { StructureElement, type Structure } from 'molstar/lib/mol-model/structure'
import { Color } from 'molstar/lib/mol-util/color'
import lightCss from 'molstar/build/viewer/theme/light.css'
import darkCss from 'molstar/build/viewer/theme/dark.css'
import { summarizeStructure } from './parse/index.ts'
import { molstarFormatOf } from './formats.ts'
import {
  Mol4AgentError,
  type CaptureOptions,
  type CommandResult,
  type InspectRequest,
  type InspectResult,
  type MolCommand,
  type MolFormat,
  type StructureData,
  type StructureSummary,
} from './protocol.ts'
import { compileSelector, selectorSchema } from './select.ts'
import { applyRepresentation } from './represent.ts'
import { inspectViewer } from './inspect-plugin.ts'
import { formatColor, parseColor } from './color.ts'

export interface MolViewerOptions {
  readonly container: HTMLElement
  readonly theme?: 'light' | 'dark'
  readonly background?: string | number
}

export interface ViewerDiagnostics {
  readonly canvas: { readonly width: number; readonly height: number; readonly clientWidth: number; readonly clientHeight: number }
  readonly host: { readonly clientWidth: number; readonly clientHeight: number }
  readonly structures: number
  readonly components: number
  readonly representations: number
  readonly atoms: number
}

export interface MolViewer {
  /** Snapshot of layout and Mol* hierarchy counts, for diagnostics. */
  diagnostics(): ViewerDiagnostics
  /** Replace the displayed structure with adapter-supplied bytes. */
  load(data: StructureData, options?: { preset?: string }): Promise<StructureSummary>
  /** Current summary, when a structure is loaded. */
  summary(): StructureSummary | undefined
  /**
   * Read the loaded structure and the way Mol* currently draws it.
   *
   * Read-only: unlike {@link MolViewer.execute} it changes nothing, and its
   * answers include human-driven viewer state (clicked selection, panel
   * styles) that never passed through the adapter's command log.
   */
  inspect(request?: InspectRequest): InspectResult
  /** Execute one command against the loaded structure. */
  execute(command: MolCommand): Promise<CommandResult>
  /** Execute commands in order, returning per-command results. */
  apply(commands: readonly MolCommand[]): Promise<readonly CommandResult[]>
  /** Render the current viewport to PNG bytes. */
  capture(options?: CaptureOptions): Promise<Uint8Array>
  /** Swap the Mol* UI skin and canvas background without rebuilding the viewer. */
  setTheme(theme: 'light' | 'dark'): void
  resize(): void
  dispose(): void
}

/** Create the official Mol* viewer inside `options.container`. */
export async function createMolViewer(options: MolViewerOptions): Promise<MolViewer> {
  let theme = options.theme ?? 'dark'
  const themeBackground = (): string => (theme === 'dark' ? '#101418' : '#ffffff')
  // Validate adapter-provided background before mounting anything.
  const background = resolveColor(options.background ?? themeBackground())

  const host = document.createElement('div')
  host.style.cssText = 'position:relative;width:100%;height:100%;min-height:0;overflow:hidden;'
  options.container.appendChild(host)

  // The document body can mount before the sidebar gives it a size. Mol* needs
  // a real box for its UI and camera; wait for one, then keep following resizes.
  await waitForHostSize(host, 3000)

  const themeStyle = document.createElement('style')
  themeStyle.dataset.mol4agentTheme = theme
  themeStyle.textContent = theme === 'dark' ? darkCss : lightCss
  document.head.appendChild(themeStyle)
  const removeCss = (): void => { themeStyle.remove() }

  let plugin: PluginContext
  // Mol*'s reactive layout keys off the browser window, not this container. A
  // narrow sidebar inside a wide/portrait window then picks the wrong breakpoint
  // and the panels land outside the visible area; only fullscreen appears to
  // work. Choose the layout mode from the viewer container itself.
  const layoutMode = host.clientWidth > host.clientHeight ? 'landscape' : 'portrait'
  try {
    plugin = await createPluginUI({
      target: host,
      render: renderReact18,
      spec: {
        ...DefaultPluginUISpec(),
        layout: {
          initial: {
            isExpanded: false,
            // The official control-panel set starts closed. The viewport's
            // sliders button toggles it; PluginUI only renders regions while
            // showControls is true, so the toggle starts from false.
            showControls: false,
            controlsDisplay: layoutMode,
            regionState: { left: 'full', top: 'full', right: 'full', bottom: 'hidden' },
            expandToFullscreen: false,
          },
        },
        config: [[PluginConfig.VolumeStreaming.Enabled, false]],
      },
    })
  } catch (error) {
    removeCss()
    host.remove()
    throw error
  }
  plugin.canvas3d?.setProps({ renderer: { backgroundColor: Color(background) } })

  let pendingFocus: Structure | undefined
  const focusLoaded = (): void => {
    if (pendingFocus === undefined) return
    if (host.clientWidth < 32 || host.clientHeight < 32) return
    plugin.handleResize()
    plugin.managers.camera.focusLoci(StructureElement.Loci.all(pendingFocus))
    pendingFocus = undefined
    plugin.canvas3d?.requestDraw()
  }

  const resizeObserver = new ResizeObserver(() => {
    plugin.handleResize()
    focusLoaded()
    plugin.canvas3d?.requestDraw()
  })
  resizeObserver.observe(host)

  let summary: StructureSummary | undefined
  let disposed = false

  const viewerApi: MolViewer = {
    diagnostics() {
      const structures = plugin.managers.structure.hierarchy.current.structures
      let components = 0
      let representations = 0
      for (const structure of structures) {
        components += structure.components.length
        for (const component of structure.components) {
          representations += component.representations.length
        }
      }
      const canvas = host.querySelector('canvas')
      return {
        canvas: {
          width: canvas?.width ?? 0,
          height: canvas?.height ?? 0,
          clientWidth: canvas?.clientWidth ?? 0,
          clientHeight: canvas?.clientHeight ?? 0,
        },
        host: { clientWidth: host.clientWidth, clientHeight: host.clientHeight },
        structures: structures.length,
        components,
        representations,
        atoms: summary?.atomCount ?? 0,
      }
    },

    async load(data, loadOptions) {
      assertAlive()
      // Measurements live in a root-level group that is not covered by the
      // structure/trajectory refs removed below. Clear it explicitly so a new
      // scene does not keep stale measurement lines/labels.
      const measurementGroup = StateSelection.findTagInSubtree(
        plugin.state.data.tree,
        StateTransform.RootRef,
        MeasurementGroupTag,
      )
      if (measurementGroup !== undefined) {
        try {
          await plugin.state.data.build().delete(measurementGroup).commit()
        } catch (reason) {
          console.warn('[mol4agent] could not clear previous measurements', reason)
        }
      }
      // Starting a new scene must not keep the previous structure's components
      // (and their selection representations) in the same Mol* state tree.
      const previous = plugin.managers.structure.hierarchy.current
      const previousRefs = [...previous.structures, ...previous.trajectories]
      if (previousRefs.length > 0) {
        try {
          await plugin.managers.structure.hierarchy.remove(previousRefs, false)
        } catch (reason) {
          console.warn('[mol4agent] could not clear the previous structure', reason)
        }
      }
      const descriptor = molstarFormatOf(data.format)
      const label = data.label ?? 'structure'
      const binary = data.binary ?? descriptor.binary
      // Adapters hand bytes; Mol*'s text parsers need a String data object.
      // Wrapping a PDB/mmCIF file as Binary parses to an empty trajectory.
      const payload = binary
        ? data.data as Uint8Array<ArrayBuffer>
        : typeof data.data === 'string'
          ? data.data
          : new TextDecoder('utf-8', { fatal: false }).decode(data.data)
      const dataObject = await plugin.builders.data.rawData({ data: payload, label })
      const trajectory = await plugin.builders.structure.parseTrajectory(dataObject, descriptor.parser)
      const requestedPreset = loadOptions?.preset
      const representationPreset = requestedPreset === undefined || requestedPreset === 'default'
        ? undefined
        : requestedPreset
      const preset = await plugin.builders.structure.hierarchy.applyPreset(
        trajectory,
        'default',
        representationPreset === undefined
          ? undefined
          : { representationPreset: representationPreset as never },
      )
      const structure = (preset as { structure?: { cell?: { obj?: { data?: Structure } } } } | undefined)
        ?.structure?.cell?.obj?.data
        ?? plugin.managers.structure.hierarchy.current.structures[0]?.cell.obj?.data
      if (structure === undefined) {
        throw new Mol4AgentError(
          'LOAD_FAILED',
          'Mol* parsed the file but did not build a structure hierarchy; the format may be unsupported for this file',
        )
      }
      pendingFocus = structure
      focusLoaded()
      summary = summarizeSafely(data)
      plugin.canvas3d?.requestDraw()
      return summary
    },

    summary() {
      return summary
    },

    inspect(request) {
      assertAlive()
      return inspectViewer(plugin, request ?? {})
    },

    async execute(command) {
      try {
        assertAlive()
        return await executeCommand(plugin, command, summary !== undefined, theme)
      } catch (error) {
        if (error instanceof Mol4AgentError) {
          return { ok: false, op: command.op, code: error.code, message: error.message }
        }
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, op: command.op, code: 'INVALID_COMMAND', message }
      }
    },

    async apply(commands) {
      const results: CommandResult[] = []
      for (const command of commands) results.push(await viewerApi.execute(command))
      return results
    },

    setTheme(next) {
      if (next === theme) return
      theme = next
      themeStyle.dataset.mol4agentTheme = next
      themeStyle.textContent = next === 'dark' ? darkCss : lightCss
      plugin.canvas3d?.setProps({
        renderer: { backgroundColor: Color(resolveColor(themeBackground())) },
      })
      plugin.canvas3d?.requestDraw()
    },

    async capture(captureOptions) {
      assertAlive()
      focusLoaded()
      if (host.clientWidth === 0 || host.clientHeight === 0) {
        throw new Mol4AgentError('CAPTURE_FAILED', 'the viewer has no layout size yet')
      }
      const helper = plugin.helpers.viewportScreenshot
      if (helper === undefined) throw new Mol4AgentError('CAPTURE_FAILED', 'viewport screenshot helper is unavailable')
      const width = captureOptions?.width ?? 1024
      const height = captureOptions?.height ?? 768
      const captureBackground = captureOptions?.background === undefined
        ? undefined
        : resolveColor(captureOptions.background)
      const previousBackground = plugin.canvas3d?.props.renderer.backgroundColor
      try {
        helper.behaviors.values.next({
          ...helper.values,
          resolution: { name: 'custom', params: { width, height } },
          transparent: captureOptions?.transparent ?? false,
        } as never)
        if (captureBackground !== undefined && plugin.canvas3d !== undefined) {
          plugin.canvas3d.setProps({ renderer: { backgroundColor: Color(captureBackground) } })
        }
        const uri = await helper.getImageDataUri()
        const comma = uri.indexOf(',')
        if (comma < 0) throw new Mol4AgentError('CAPTURE_FAILED', 'screenshot helper returned no data URI')
        return decodeBase64(uri.slice(comma + 1))
      } catch (reason) {
        if (reason instanceof Mol4AgentError) throw reason
        throw new Mol4AgentError('CAPTURE_FAILED', reason instanceof Error ? reason.message : String(reason))
      } finally {
        if (captureOptions?.background !== undefined && previousBackground !== undefined && plugin.canvas3d !== undefined) {
          plugin.canvas3d.setProps({ renderer: { backgroundColor: previousBackground } })
          plugin.canvas3d.requestDraw()
        }
      }
    },

    resize() {
      plugin.handleResize()
      plugin.canvas3d?.requestDraw()
    },

    dispose() {
      if (disposed) return
      disposed = true
      resizeObserver.disconnect()
      plugin.dispose()
      removeCss()
      host.remove()
    },
  }

  function assertAlive(): void {
    if (disposed) throw new Mol4AgentError('DISPOSED', 'viewer has been disposed')
  }

  return viewerApi
}

async function executeCommand(
  plugin: PluginContext,
  command: MolCommand,
  hasStructure: boolean,
  theme: 'light' | 'dark',
): Promise<CommandResult> {
  if (!hasStructure) {
    return { ok: false, op: command.op, code: 'NO_STRUCTURE', message: 'load a structure before sending viewer commands' }
  }
  switch (command.op) {
    case 'represent': {
      return applyRepresentation(plugin, command)
    }

    case 'select': {
      const compiled = compileSelector(command.target)
      const mode = command.mode ?? 'select'
      applyStructureInteractivity(plugin, {
        ...compiled,
        action: command.focus === true ? [mode, 'focus'] : mode,
        applyGranularity: true,
      } as never)
      return { ok: true, op: command.op, message: `${mode}ed ${command.target.kind}` }
    }

    case 'clear-selection': {
      const mode = command.mode ?? 'select'
      applyStructureInteractivity(plugin, { action: mode } as never)
      return { ok: true, op: command.op, message: `cleared ${mode}` }
    }

    case 'focus': {
      if (command.target === undefined) {
        const structure = firstStructure(plugin)
        if (structure === undefined) return { ok: false, op: command.op, code: 'NO_STRUCTURE', message: 'no structure is loaded' }
        plugin.managers.camera.focusLoci(StructureElement.Loci.all(structure))
        return { ok: true, op: command.op, message: 'focused the whole structure' }
      }
      applyStructureInteractivity(plugin, { ...compileSelector(command.target), action: 'focus' } as never)
      return { ok: true, op: command.op, message: `focused ${command.target.kind}` }
    }

    case 'camera': {
      plugin.managers.camera.reset()
      return { ok: true, op: command.op, message: 'camera reset' }
    }

    case 'background': {
      if (plugin.canvas3d === undefined) {
        return { ok: false, op: command.op, code: 'INVALID_COMMAND', message: 'canvas is unavailable' }
      }
      const color = resolveColor(command.color === 'theme' ? (theme === 'dark' ? '#101418' : '#ffffff') : command.color)
      plugin.canvas3d.setProps({ renderer: { backgroundColor: Color(color) } })
      plugin.canvas3d.requestDraw()
      return { ok: true, op: command.op, message: `background ${formatColor(color)}` }
    }

    case 'measure': {
      const structure = firstStructure(plugin)
      if (structure === undefined) {
        return { ok: false, op: command.op, code: 'NO_STRUCTURE', message: 'no structure is loaded' }
      }
      const schemas = command.targets.map(selectorSchema)
      if (schemas.some(schema => schema === undefined)) {
        return invalid(command.op, 'measure targets must be chain/residue/comp/schema selectors, not semantic categories')
      }
      const loci = schemas.map(schema => StructureElement.Schema.toLoci(structure, schema as never))
      const manager = plugin.managers.structure.measurement
      const needed = command.kind === 'distance' ? 2 : command.kind === 'angle' ? 3 : 4
      if (loci.length !== needed) return invalid(command.op, `${command.kind} needs exactly ${needed} targets`)
      if (command.kind === 'distance') await manager.addDistance(loci[0]!, loci[1]!)
      else if (command.kind === 'angle') await manager.addAngle(loci[0]!, loci[1]!, loci[2]!)
      else await manager.addDihedral(loci[0]!, loci[1]!, loci[2]!, loci[3]!)
      return { ok: true, op: command.op, message: `${command.kind} measurement added` }
    }

    case 'label': {
      const schema = selectorSchema(command.target)
      if (schema === undefined) return invalid(command.op, 'label targets must be chain/residue/comp/schema selectors')
      const structure = firstStructure(plugin)
      if (structure === undefined) {
        return { ok: false, op: command.op, code: 'NO_STRUCTURE', message: 'no structure is loaded' }
      }
      const loci = StructureElement.Schema.toLoci(structure, schema as never)
      await plugin.managers.structure.measurement.addLabel(
        loci,
        command.text === undefined
          ? undefined
          : { visualParams: { customText: command.text } as never },
      )
      return { ok: true, op: command.op, message: 'label added' }
    }
  }
}

function firstStructure(plugin: PluginContext): Structure | undefined {
  return plugin.managers.structure.hierarchy.current.structures[0]?.cell.obj?.data
}

function invalid(op: MolCommand['op'], message: string): CommandResult {
  return { ok: false, op, code: 'INVALID_COMMAND', message }
}

function resolveColor(value: unknown): number {
  try {
    return parseColor(value)
  } catch (error) {
    throw new Mol4AgentError('INVALID_COMMAND', error instanceof Error ? error.message : String(error))
  }
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function summarizeSafely(data: StructureData): StructureSummary {
  try {
    return summarizeStructure(data)
  } catch {
    return {
      format: data.format,
      label: data.label,
      atomCount: 0,
      residueCount: 0,
      modelCount: 1,
      chains: [],
      ligands: [],
      complete: false,
    }
  }
}

async function waitForHostSize(host: HTMLElement, timeoutMs: number): Promise<void> {
  if (host.clientWidth >= 32 && host.clientHeight >= 32) return
  await new Promise<void>(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(() => {
      if (host.clientWidth < 32 || host.clientHeight < 32) return
      observer.disconnect()
      if (timer !== undefined) clearTimeout(timer)
      resolve()
    })
    observer.observe(host)
    timer = setTimeout(() => {
      observer.disconnect()
      resolve()
    }, timeoutMs)
  })
}
