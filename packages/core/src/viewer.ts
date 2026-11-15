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
import { StructureElement, type Structure } from 'molstar/lib/mol-model/structure'
import { Color } from 'molstar/lib/mol-util/color'
import lightCss from 'molstar/build/viewer/theme/light.css'
import darkCss from 'molstar/build/viewer/theme/dark.css'
import { summarizeStructure } from './parse/index.ts'
import { molstarFormatOf } from './formats.ts'
import {
  COLOR_THEMES,
  Mol4AgentError,
  REPRESENTATION_TYPES,
  type CaptureOptions,
  type CommandResult,
  type MolCommand,
  type MolFormat,
  type StructureData,
  type StructureSelector,
  type StructureSummary,
} from './protocol.ts'
import { compileSelector, selectorSchema } from './select.ts'

let globalComponentSeq = 0

export interface MolViewerOptions {
  readonly container: HTMLElement
  readonly theme?: 'light' | 'dark'
  readonly background?: string
  readonly onError?: (error: unknown) => void
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
  const host = document.createElement('div')
  host.style.cssText = 'position:relative;width:100%;height:100%;min-height:0;overflow:hidden;'
  options.container.appendChild(host)

  // The document body can mount before the sidebar gives it a size. Mol* needs
  // a real box for its UI and camera; wait for one, then keep following resizes.
  await waitForHostSize(host, 3000)

  let theme = options.theme ?? 'dark'
  const background = options.background ?? (theme === 'dark' ? '#101418' : '#ffffff')
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
  plugin.canvas3d?.setProps({ renderer: { backgroundColor: toColor(background) } })

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
      const preset = await plugin.builders.structure.hierarchy.applyPreset(
        trajectory,
        (loadOptions?.preset ?? 'default') as never,
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

    async execute(command) {
      assertAlive()
      try {
        return await executeCommand(plugin, command, summary !== undefined)
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
        renderer: { backgroundColor: toColor(next === 'dark' ? '#101418' : '#ffffff') },
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
      helper.behaviors.values.next({
        ...helper.values,
        resolution: { name: 'custom', params: { width, height } },
        transparent: captureOptions?.transparent ?? false,
      } as never)
      if (captureOptions?.background !== undefined && plugin.canvas3d !== undefined) {
        plugin.canvas3d.setProps({ renderer: { backgroundColor: toColor(captureOptions.background) } })
      }
      const uri = await helper.getImageDataUri()
      const comma = uri.indexOf(',')
      if (comma < 0) throw new Mol4AgentError('CAPTURE_FAILED', 'screenshot helper returned no data URI')
      return decodeBase64(uri.slice(comma + 1))
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
): Promise<CommandResult> {
  if (!hasStructure) {
    return { ok: false, op: command.op, code: 'NO_STRUCTURE', message: 'load a structure before sending viewer commands' }
  }
  switch (command.op) {
    case 'represent': {
      const style = command.style
      if (style.type !== undefined && !(REPRESENTATION_TYPES as readonly string[]).includes(style.type)) {
        return invalid(command.op, `unknown representation "${style.type}"; supported: ${REPRESENTATION_TYPES.join(', ')}`)
      }
      if (style.color !== undefined && !(COLOR_THEMES as readonly string[]).includes(style.color)) {
        return invalid(command.op, `unknown colour theme "${style.color}"; supported: ${COLOR_THEMES.join(', ')}`)
      }
      const structures = plugin.managers.structure.hierarchy.current.structures
      if (structures.length === 0) {
        return { ok: false, op: command.op, code: 'NO_STRUCTURE', message: 'no structure is loaded' }
      }
      // A target means "add this style to a selection", not "replace the whole
      // scene". The selection gets its own component so the rest of the
      // structure keeps its current representation.
      if (command.target !== undefined) {
        const expression = selectionExpression(command.target)
        let targeted = 0
        for (const structure of structures) {
          const component = await plugin.builders.structure.tryCreateComponentFromExpression(
            structure.cell,
            expression,
            selectionKey(command.target),
            { label: 'mol4agent selection' },
          )
          if (component === undefined) continue
          const rep = await plugin.builders.structure.representation.addRepresentation(component as never, {
            type: (style.type ?? 'ball-and-stick') as never,
            color: (style.color ?? 'uniform') as never,
            ...(style.colorParams === undefined ? {} : { colorParams: style.colorParams as never }),
          }, { tag: 'mol4agent-selection' } as never)
          if (rep !== undefined) targeted += 1
        }
        if (targeted === 0) {
          return {
            ok: false,
            op: command.op,
            code: 'REPRESENT_FAILED',
            message: `Mol* did not create a representation for ${command.target.kind}`,
          }
        }
        plugin.canvas3d?.requestDraw()
        return {
          ok: true,
          op: command.op,
          message: `applied ${style.type ?? 'ball-and-stick'} / ${style.color ?? 'uniform'} to ${command.target.kind}`,
        }
      }

      const previousComponents = structures.flatMap(structure => [...structure.components])
      // A single Cartoon representation hides HETATM ligands. Use Mol*'s
      // polymer-and-ligand preset for the default cartoon style so ATP/HEM/etc.
      // stay visible. A uniform colorParams is passed through the preset theme
      // so "gray cartoon" still keeps the ligand representation.
      const polymerAndLigand = style.type === undefined || style.type === 'cartoon'
      let added = 0
      if (polymerAndLigand) {
        for (const structure of structures) {
          await plugin.builders.structure.representation.applyPreset(
            structure.cell,
            'polymer-and-ligand',
            {
              theme: {
                globalName: style.color ?? 'chain-id',
                ...(style.colorParams === undefined ? {} : { globalColorParams: { value: style.colorParams.value } }),
              },
            } as never,
          )
          added += 1
        }
      } else {
        // Representations live under components. Build one fresh all-atom
        // component, then drop the previous components; removing only their
        // reps can take the reused component (and the new reps) with it.
        const all = selectionExpression({ kind: 'all' })
        for (const structure of structures) {
          const component = await plugin.builders.structure.tryCreateComponentFromExpression(
            structure.cell,
            all,
            `mol4agent-global-${globalComponentSeq += 1}`,
            { label: 'mol4agent global' },
          )
          if (component === undefined) continue
          const rep = await plugin.builders.structure.representation.addRepresentation(component as never, {
            type: (style.type ?? 'cartoon') as never,
            color: (style.color ?? 'chain-id') as never,
            ...(style.colorParams === undefined ? {} : { colorParams: style.colorParams as never }),
          })
          if (rep !== undefined) added += 1
        }
      }
      if (added === 0) {
        return {
          ok: false,
          op: command.op,
          code: 'REPRESENT_FAILED',
          message: `Mol* did not create a representation for ${style.type ?? 'cartoon'}`,
        }
      }
      try {
        // The representation preset updates the existing tagged representations
        // in place. Removing the pre-command refs would remove those updates
        // (the refs are the same transforms), leaving a blank viewport.
        if (!polymerAndLigand && previousComponents.length > 0) {
          await plugin.managers.structure.hierarchy.remove(previousComponents, true)
        }
      } catch (reason) {
        console.warn('[mol4agent] could not remove the previous representation', reason)
      }
      plugin.canvas3d?.requestDraw()
      return { ok: true, op: command.op, message: `applied ${style.type ?? 'cartoon'} / ${style.color ?? 'chain-id'}` }
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
      const color = command.color === 'theme' ? Color(0xffffff) : toColor(command.color)
      plugin.canvas3d.setProps({ renderer: { backgroundColor: color } })
      plugin.canvas3d.requestDraw()
      return { ok: true, op: command.op, message: `background ${command.color}` }
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
      if (loci.length < needed) return invalid(command.op, `${command.kind} needs at least ${needed} targets`)
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

function selectionExpression(selector: StructureSelector) {
  const compiled = compileSelector(selector)
  return 'elements' in compiled
    ? StructureElement.Schema.toExpression(compiled.elements as never)
    : compiled.expression(undefined)
}

/** Stable key so repeated styles of one selection update the same component. */
function selectionKey(selector: StructureSelector): string {
  let hash = 2166136261
  for (const char of JSON.stringify(selector)) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return `mol4agent-sel-${(hash >>> 0).toString(36)}`
}

function firstStructure(plugin: PluginContext): Structure | undefined {
  return plugin.managers.structure.hierarchy.current.structures[0]?.cell.obj?.data
}

function invalid(op: MolCommand['op'], message: string): CommandResult {
  return { ok: false, op, code: 'INVALID_COMMAND', message }
}

function toColor(value: string): Color {
  const trimmed = value.trim()
  if (/^#[0-9a-f]{6}$/iu.test(trimmed) || /^#[0-9a-f]{8}$/iu.test(trimmed)) {
    return Color(Number.parseInt(trimmed.slice(1), 16))
  }
  return Color(0xffffff)
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
