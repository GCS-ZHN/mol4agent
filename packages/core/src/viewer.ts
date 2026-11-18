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
import { QueryContext, StructureElement, StructureSelection, type Structure } from 'molstar/lib/mol-model/structure'
import { StructureSelectionQueries } from 'molstar/lib/mol-plugin-state/helpers/structure-selection-query'
import { StateTransforms } from 'molstar/lib/mol-plugin-state/transforms'
import { Mat4 } from 'molstar/lib/mol-math/linear-algebra'
import { alignAndSuperpose } from 'molstar/lib/mol-model/structure/structure/util/superposition'
import { tmAlign } from 'molstar/lib/mol-model/structure/structure/util/tm-align'
import { Color } from 'molstar/lib/mol-util/color'
import lightCss from 'molstar/build/viewer/theme/light.css'
import darkCss from 'molstar/build/viewer/theme/dark.css'
import { summarizeStructure } from './parse/index.ts'
import { molstarFormatOf } from './formats.ts'
import {
  Mol4AgentError,
  isStructureId,
  type AlignmentResult,
  type CaptureOptions,
  type CommandResult,
  type LoadedStructure,
  type InspectRequest,
  type InspectResult,
  type MolCommand,
  type MolFormat,
  type StructureData,
  type StructureSelector,
  type StructureSummary,
  type TmScoreRequest,
  type TmScoreResult,
} from './protocol.ts'
import { compileSelector, describeSelector, selectorExpression, selectorSchema } from './select.ts'
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
  /**
   * Replace the displayed scene with adapter-supplied bytes.
   *
   * The previous structures, their components, and measurements are cleared.
   * `options.id` sets the id of the new (primary) structure; it defaults to
   * `structure`.
   */
  load(data: StructureData, options?: { preset?: string; id?: string }): Promise<StructureSummary>
  /**
   * Add another structure to the current scene without clearing existing ones.
   *
   * Returns the stable id and summary. `options.id` must be unique within the
   * scene; a generated id (`structure-2`, `structure-3`, ...) is used when it
   * is omitted.
   */
  addStructure(data: StructureData, options?: { preset?: string; id?: string }): Promise<LoadedStructure>
  /** Remove one structure (and its components) from the scene. */
  removeStructure(id: string): Promise<void>
  /** Structures currently loaded in this scene, in load order. */
  listStructures(): readonly LoadedStructure[]
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
  /**
   * Compute TM-align metrics for two selections without moving either one.
   *
   * Read-only, like {@link MolViewer.inspect}; RMSD is measured after optimal
   * superposition of the aligned polymer-trace atoms, not in the current frame.
   */
  tmScore(request: TmScoreRequest): TmScoreResult
  /** Execute one command against the loaded structures. */
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

/** Internal bookkeeping for one structure in the scene. */
interface SceneEntry {
  readonly id: string
  readonly cellRef: string
  readonly label?: string
  readonly format: MolFormat
  readonly summary: StructureSummary
}

interface SceneState {
  entries: SceneEntry[]
  summary?: StructureSummary
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

  let pendingFocus: Structure[] | undefined
  const focusLoaded = (): void => {
    if (pendingFocus === undefined || pendingFocus.length === 0) return
    if (host.clientWidth < 32 || host.clientHeight < 32) return
    plugin.handleResize()
    // focusLoci accepts several loci; this frames every loaded structure while
    // keeping the single-structure behavior of the original load path.
    plugin.managers.camera.focusLoci(pendingFocus.map(structure => StructureElement.Loci.all(structure)))
    pendingFocus = undefined
    plugin.canvas3d?.requestDraw()
  }

  const resizeObserver = new ResizeObserver(() => {
    plugin.handleResize()
    focusLoaded()
    plugin.canvas3d?.requestDraw()
  })
  resizeObserver.observe(host)

  const scene: SceneState = { entries: [] }
  let disposed = false

  const nextDefaultId = (): string => {
    let index = 2
    while (scene.entries.some(entry => entry.id === `structure-${index}`)) index += 1
    return `structure-${index}`
  }

  const publicEntry = (entry: SceneEntry): LoadedStructure => ({
    id: entry.id,
    format: entry.format,
    summary: entry.summary,
    ...(entry.label === undefined ? {} : { label: entry.label }),
  })

  const addToScene = async (
    data: StructureData,
    options?: { preset?: string; id?: string },
  ): Promise<LoadedStructure> => {
    const id = options?.id ?? nextDefaultId()
    if (!isStructureId(id)) {
      throw new Mol4AgentError(
        'INVALID_COMMAND',
        `invalid structure id "${id}"; use 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit`,
      )
    }
    if (scene.entries.some(entry => entry.id === id)) {
      throw new Mol4AgentError('DUPLICATE_STRUCTURE_ID', `structure id "${id}" is already loaded`)
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
    const requestedPreset = options?.preset
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
    const presetStructure = (preset as {
      structure?: { cell?: { obj?: { data?: Structure }; transform?: { ref?: string } } }
    } | undefined)?.structure
    const structure = presetStructure?.cell?.obj?.data
      ?? plugin.managers.structure.hierarchy.current.structures.at(-1)?.cell.obj?.data
    const cellRef = presetStructure?.cell?.transform?.ref
      ?? plugin.managers.structure.hierarchy.current.structures.at(-1)?.cell.transform.ref
    if (structure === undefined || cellRef === undefined) {
      throw new Mol4AgentError(
        'LOAD_FAILED',
        'Mol* parsed the file but did not build a structure hierarchy; the format may be unsupported for this file',
      )
    }
    const entry: SceneEntry = {
      id,
      cellRef,
      format: data.format,
      summary: summarizeSafely(data),
      ...(data.label === undefined ? {} : { label: data.label }),
    }
    scene.entries = [...scene.entries, entry]
    scene.summary = entry.summary
    // Frame the whole scene: after adding a second structure the user needs to
    // see the pair, not just the newcomer that may be far away.
    pendingFocus = scene.entries
      .map(item => rootStructureOf(plugin, item))
      .filter((item): item is Structure => item !== undefined)
    focusLoaded()
    plugin.canvas3d?.requestDraw()
    return publicEntry(entry)
  }

  const removeFromScene = async (id: string): Promise<void> => {
    const entry = scene.entries.find(item => item.id === id)
    if (entry === undefined) {
      throw new Mol4AgentError('UNKNOWN_STRUCTURE', `no structure with id "${id}" is loaded`)
    }
    try {
      await plugin.managers.structure.hierarchy.remove([entry.cellRef], false)
    } catch (reason) {
      throw new Mol4AgentError(
        'INVALID_COMMAND',
        `could not remove structure "${id}": ${reason instanceof Error ? reason.message : String(reason)}`,
      )
    }
    scene.entries = scene.entries.filter(item => item.id !== id)
    scene.summary = scene.entries.at(-1)?.summary
    pendingFocus = undefined
    plugin.canvas3d?.requestDraw()
  }

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
        atoms: scene.entries.reduce((count, entry) => count + entry.summary.atomCount, 0),
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
      scene.entries = []
      scene.summary = undefined
      const entry = await addToScene(data, { ...loadOptions, id: loadOptions?.id ?? 'structure' })
      return entry.summary
    },

    async addStructure(data, addOptions) {
      assertAlive()
      return addToScene(data, addOptions)
    },

    async removeStructure(id) {
      assertAlive()
      await removeFromScene(id)
    },

    listStructures() {
      return scene.entries.map(publicEntry)
    },

    summary() {
      return scene.summary
    },

    inspect(request) {
      assertAlive()
      return inspectViewer(plugin, request ?? {}, structureId => {
        const entry = findEntry(scene, structureId)
        if (entry === undefined) {
          throw new Mol4AgentError('UNKNOWN_STRUCTURE', `no structure with id "${structureId}" is loaded`)
        }
        const structure = effectiveStructureOf(plugin, entry)
        return structure === undefined ? [] : [structure]
      })
    },

    tmScore(request) {
      assertAlive()
      return tmScoreStructures(plugin, scene, request)
    },

    async execute(command) {
      try {
        assertAlive()
        return await executeCommand(plugin, command, scene, theme)
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
  scene: SceneState,
  theme: 'light' | 'dark',
): Promise<CommandResult> {
  if (scene.entries.length === 0) {
    return { ok: false, op: command.op, code: 'NO_STRUCTURE', message: 'load a structure before sending viewer commands' }
  }
  switch (command.op) {
    case 'represent': {
      if (command.target?.structureId === undefined) return applyRepresentation(plugin, command)
      const scoped = scopedEntries(scene, command.target)
        .map(entry => currentStructureRef(plugin, entry))
        .filter((ref): ref is NonNullable<typeof ref> => ref !== undefined)
      return applyRepresentation(plugin, command, scoped)
    }

    case 'select': {
      const mode = command.mode ?? 'select'
      if (mode === 'select') plugin.managers.interactivity.lociSelects.deselectAll()
      let focused = false
      let matched = 0
      for (const entry of scopedEntries(scene, command.target)) {
        const loci = lociOfSelector(plugin, entry, command.target)
        if (loci === undefined || StructureElement.Loci.isEmpty(loci)) continue
        matched += 1
        if (mode === 'select') plugin.managers.interactivity.lociSelects.select({ loci }, true)
        else plugin.managers.interactivity.lociHighlights.highlight({ loci }, true)
        if (command.focus === true && !focused) {
          plugin.managers.camera.focusLoci(loci)
          focused = true
        }
      }
      if (matched === 0) {
        return {
          ok: false,
          op: command.op,
          code: 'NO_STRUCTURE',
          message: `the ${command.target.kind} selector matched no atoms`,
        }
      }
      return { ok: true, op: command.op, message: `${mode}ed ${command.target.kind}` }
    }

    case 'clear-selection': {
      const mode = command.mode ?? 'select'
      applyStructureInteractivity(plugin, { action: mode } as never)
      return { ok: true, op: command.op, message: `cleared ${mode}` }
    }

    case 'focus': {
      if (command.target === undefined) {
        const loci = scene.entries
          .map(entry => effectiveStructureOf(plugin, entry))
          .filter((structure): structure is Structure => structure !== undefined)
          .map(structure => StructureElement.Loci.all(structure))
          .filter(loci => !StructureElement.Loci.isEmpty(loci))
        if (loci.length === 0) return { ok: false, op: command.op, code: 'NO_STRUCTURE', message: 'no structure is loaded' }
        plugin.managers.camera.focusLoci(loci)
        return { ok: true, op: command.op, message: 'focused the whole scene' }
      }
      const loci: StructureElement.Loci[] = []
      for (const entry of scopedEntries(scene, command.target)) {
        const entryLoci = lociOfSelector(plugin, entry, command.target)
        if (entryLoci !== undefined && !StructureElement.Loci.isEmpty(entryLoci)) loci.push(entryLoci)
      }
      if (loci.length === 0) {
        return { ok: false, op: command.op, code: 'NO_STRUCTURE', message: `the ${command.target.kind} selector matched no atoms` }
      }
      plugin.managers.camera.focusLoci(loci)
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
      const schemas = command.targets.map(selectorSchema)
      if (schemas.some(schema => schema === undefined)) {
        return invalid(command.op, 'measure targets must be chain/residue/comp/schema selectors, not semantic categories')
      }
      const loci: StructureElement.Loci[] = []
      for (let index = 0; index < command.targets.length; index += 1) {
        const selector = command.targets[index]!
        const schema = schemas[index]!
        const entryLoci = lociOfSchema(plugin, scene, selector, schema)
        if (entryLoci === undefined) {
          return {
            ok: false,
            op: command.op,
            code: 'NO_STRUCTURE',
            message: `measure target ${index + 1} matched no atoms`,
          }
        }
        loci.push(entryLoci)
      }
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
      const loci = lociOfSchema(plugin, scene, command.target, schema)
      if (loci === undefined) {
        return { ok: false, op: command.op, code: 'NO_STRUCTURE', message: 'the label selector matched no atoms' }
      }
      await plugin.managers.structure.measurement.addLabel(
        loci,
        command.text === undefined
          ? undefined
          : { visualParams: { customText: command.text } as never },
      )
      return { ok: true, op: command.op, message: 'label added' }
    }

    case 'remove-structure': {
      const entry = findEntry(scene, command.structureId)
      if (entry === undefined) {
        return {
          ok: false,
          op: command.op,
          code: 'UNKNOWN_STRUCTURE',
          message: `no structure with id "${command.structureId}" is loaded`,
        }
      }
      try {
        await plugin.managers.structure.hierarchy.remove([entry.cellRef], false)
      } catch (reason) {
        return {
          ok: false,
          op: command.op,
          code: 'INVALID_COMMAND',
          message: `could not remove structure "${command.structureId}": ${reason instanceof Error ? reason.message : String(reason)}`,
        }
      }
      scene.entries = scene.entries.filter(item => item.id !== command.structureId)
      scene.summary = scene.entries.at(-1)?.summary
      plugin.canvas3d?.requestDraw()
      return { ok: true, op: command.op, message: `removed structure ${command.structureId}` }
    }

    case 'visibility': {
      const entry = findEntry(scene, command.structureId)
      if (entry === undefined) {
        return {
          ok: false,
          op: command.op,
          code: 'UNKNOWN_STRUCTURE',
          message: `no structure with id "${command.structureId}" is loaded`,
        }
      }
      const ref = currentStructureRef(plugin, entry)
      if (ref === undefined) {
        return { ok: false, op: command.op, code: 'NO_STRUCTURE', message: 'the structure is no longer in the Mol* hierarchy' }
      }
      plugin.managers.structure.hierarchy.toggleVisibility([ref], command.visible ? 'show' : 'hide')
      plugin.canvas3d?.requestDraw()
      return {
        ok: true,
        op: command.op,
        message: `${command.visible ? 'showed' : 'hid'} structure ${command.structureId}`,
      }
    }

    case 'align': {
      const reference = findEntry(scene, command.reference)
      const target = findEntry(scene, command.target)
      if (reference === undefined) {
        return {
          ok: false,
          op: command.op,
          code: 'UNKNOWN_STRUCTURE',
          message: `no reference structure with id "${command.reference}" is loaded`,
        }
      }
      if (target === undefined) {
        return {
          ok: false,
          op: command.op,
          code: 'UNKNOWN_STRUCTURE',
          message: `no target structure with id "${command.target}" is loaded`,
        }
      }
      if (reference.id === target.id) {
        return invalid(command.op, 'reference and target must be different structures')
      }
      const method = command.method ?? 'tm-align'
      if (method !== 'tm-align' && method !== 'sequence') {
        return invalid(command.op, `unknown alignment method "${method}"; supported: tm-align, sequence`)
      }
      const referenceLoci = traceLociOf(plugin, reference, command.referenceChain)
      const targetLoci = traceLociOf(plugin, target, command.targetChain)
      if (referenceLoci === undefined || StructureElement.Loci.isEmpty(referenceLoci)) {
        return {
          ok: false,
          op: command.op,
          code: 'ALIGN_FAILED',
          message: command.referenceChain === undefined
            ? `reference structure "${reference.id}" has no polymer trace atoms to align`
            : `reference chain "${command.referenceChain}" has no polymer trace atoms to align`,
        }
      }
      if (targetLoci === undefined || StructureElement.Loci.isEmpty(targetLoci)) {
        return {
          ok: false,
          op: command.op,
          code: 'ALIGN_FAILED',
          message: command.targetChain === undefined
            ? `target structure "${target.id}" has no polymer trace atoms to align`
            : `target chain "${command.targetChain}" has no polymer trace atoms to align`,
        }
      }
      let result: AlignmentResult
      let bTransform: Mat4
      if (method === 'tm-align') {
        const aligned = tmAlign(referenceLoci, targetLoci)
        bTransform = aligned.bTransform
        result = {
          method,
          reference: reference.id,
          target: target.id,
          rmsd: aligned.rmsd,
          alignedLength: aligned.alignedLength,
          tmScoreA: aligned.tmScoreA,
          tmScoreB: aligned.tmScoreB,
          // Mol*'s structure-level tmAlign wrapper does not pass sequences, so
          // its sequenceIdentity is always 0. Omit it instead of reporting a
          // misleading 0%.
        }
      } else {
        const [aligned] = alignAndSuperpose([referenceLoci, targetLoci])
        if (aligned === undefined) {
          return { ok: false, op: command.op, code: 'ALIGN_FAILED', message: 'sequence alignment produced no transform' }
        }
        bTransform = aligned.bTransform
        result = {
          method,
          reference: reference.id,
          target: target.id,
          rmsd: aligned.rmsd,
          alignedLength: aligned.nAlignedElements,
        }
      }
      // If the reference is itself already transformed, compose that transform
      // so the target lands on the currently displayed reference pose.
      const referenceTransform = effectiveStructureOf(plugin, reference)?.coordinateSystem.matrix
      const matrix = referenceTransform !== undefined && !Mat4.isIdentity(referenceTransform)
        ? Mat4.mul(Mat4(), referenceTransform, bTransform)
        : bTransform
      await applyStructureTransform(plugin, target, matrix)
      // The target moved; frame the aligned pair so the result is visible. This
      // mirrors Mol*'s own superposition UI, which resets the camera afterwards.
      const referenceEffective = effectiveStructureOf(plugin, reference)
      const targetEffective = effectiveStructureOf(plugin, target)
      if (referenceEffective !== undefined && targetEffective !== undefined) {
        plugin.managers.camera.focusLoci([
          StructureElement.Loci.all(referenceEffective),
          StructureElement.Loci.all(targetEffective),
        ])
      }
      plugin.canvas3d?.requestDraw()
      const scores = result.tmScoreA === undefined
        ? `RMSD ${result.rmsd.toFixed(2)} A over ${result.alignedLength} aligned atoms`
        : `TM-score ${result.tmScoreA.toFixed(4)}/${result.tmScoreB?.toFixed(4)}, RMSD ${result.rmsd.toFixed(2)} A, `
          + `${result.alignedLength} aligned residues`
      return {
        ok: true,
        op: command.op,
        message: `aligned ${target.id} onto ${reference.id} (${method}): ${scores}`,
        data: result,
      }
    }
  }
}

function firstStructure(plugin: PluginContext): Structure | undefined {
  return plugin.managers.structure.hierarchy.current.structures[0]?.cell.obj?.data
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

function findEntry(scene: SceneState, id: string): SceneEntry | undefined {
  return scene.entries.find(entry => entry.id === id)
}

/** Entries a selector applies to; an unknown structureId is a model-facing error. */
function scopedEntries(scene: SceneState, selector: StructureSelector): readonly SceneEntry[] {
  if (selector.structureId === undefined) return scene.entries
  const entry = findEntry(scene, selector.structureId)
  if (entry === undefined) {
    throw new Mol4AgentError('UNKNOWN_STRUCTURE', `no structure with id "${selector.structureId}" is loaded`)
  }
  return [entry]
}

function currentStructureRef(plugin: PluginContext, entry: SceneEntry) {
  return plugin.managers.structure.hierarchy.current.structures
    .find(structure => structure.cell.transform.ref === entry.cellRef)
}

/** Untransformed structure data; alignment inputs use this plus a composed matrix. */
function rootStructureOf(plugin: PluginContext, entry: SceneEntry): Structure | undefined {
  const cell = plugin.state.data.cells.get(entry.cellRef)
  return (cell?.obj as { data?: Structure } | undefined)?.data
}

/** Structure data as currently displayed (after any alignment transform). */
function effectiveStructureOf(plugin: PluginContext, entry: SceneEntry): Structure | undefined {
  const ref = currentStructureRef(plugin, entry)
  return ref?.transform?.cell.obj?.data ?? ref?.cell.obj?.data
}

function lociOfSelector(
  plugin: PluginContext,
  entry: SceneEntry,
  selector: StructureSelector,
): StructureElement.Loci | undefined {
  const structure = effectiveStructureOf(plugin, entry)
  if (structure === undefined) return undefined
  const compiled = compileSelector(selector)
  return 'elements' in compiled
    ? StructureElement.Loci.fromSchema(structure, compiled.elements as never)
    : StructureElement.Loci.fromExpression(structure, compiled.expression(undefined))
}

/**
 * Resolve a schema selector to the first non-empty loci. Without a
 * `structureId`, structures are searched in load order; this keeps single
 * structure behavior and avoids failing when a chain appears in several
 * structures.
 */
function lociOfSchema(
  plugin: PluginContext,
  scene: SceneState,
  selector: StructureSelector,
  schema: NonNullable<ReturnType<typeof selectorSchema>>,
): StructureElement.Loci | undefined {
  for (const entry of scopedEntries(scene, selector)) {
    const structure = effectiveStructureOf(plugin, entry)
    if (structure === undefined) continue
    const loci = StructureElement.Schema.toLoci(structure, schema as never)
    if (!StructureElement.Loci.isEmpty(loci)) return loci
  }
  return undefined
}

/** Polymer trace (CA/C4'/P) loci, optionally restricted to one auth chain. */
function traceLociOf(
  plugin: PluginContext,
  entry: SceneEntry,
  chain: string | undefined,
): StructureElement.Loci | undefined {
  const structure = rootStructureOf(plugin, entry)
  if (structure === undefined) return undefined
  const loci = StructureSelection.toLociWithCurrentUnits(
    StructureSelectionQueries.trace.query(new QueryContext(structure)),
  )
  if (chain === undefined) return loci
  return StructureElement.Loci.intersect(loci, StructureElement.Loci.fromSchema(structure, { auth_asym_id: chain }))
}

/** Resolve one selector to its polymer-trace atoms in the displayed coordinates. */
function selectorLabel(selector: StructureSelector): string {
  const label = describeSelector(selector)
  return selector.structureId === undefined ? label : `${label} [${selector.structureId}]`
}

function traceLociForSelector(
  plugin: PluginContext,
  scene: SceneState,
  selector: StructureSelector,
): { readonly label: string; readonly loci: StructureElement.Loci; readonly atoms: number } {
  for (const entry of scopedEntries(scene, selector)) {
    // TM-align is invariant to rigid transforms, so compare the original
    // coordinates; using a decorated (moved) structure changes atom pairing.
    const structure = rootStructureOf(plugin, entry)
    if (structure === undefined) continue
    const selected = StructureElement.Loci.fromExpression(structure, selectorExpression(selector))
    const trace = StructureSelection.toLociWithCurrentUnits(
      StructureSelectionQueries.trace.query(new QueryContext(structure)),
    )
    // Keep trace order: TM-align pairs positions by index.
    const loci = StructureElement.Loci.intersect(trace, selected)
    const atoms = StructureElement.Loci.size(loci)
    if (atoms > 0) return { label: selectorLabel(selector), loci, atoms }
  }
  throw new Mol4AgentError(
    'TM_SCORE_FAILED',
    `selection "${selectorLabel(selector)}" has no polymer trace atoms (CA/C4'/P) to compare`,
  )
}

/** Read-only TM-align comparison; unlike `align` it applies no transform. */
function tmScoreStructures(plugin: PluginContext, scene: SceneState, request: TmScoreRequest): TmScoreResult {
  if (scene.entries.length === 0) {
    throw new Mol4AgentError('NO_STRUCTURE', 'load a structure before computing a TM-score')
  }
  const reference = traceLociForSelector(plugin, scene, request.reference)
  const target = traceLociForSelector(plugin, scene, request.target)
  const result = tmAlign(reference.loci, target.loci)
  if (result.alignedLength === 0) {
    throw new Mol4AgentError('TM_SCORE_FAILED', 'TM-align found no aligned residues between the selections')
  }
  return {
    method: 'tm-align',
    reference: reference.label,
    target: target.label,
    rmsd: result.rmsd,
    tmScoreA: result.tmScoreA,
    tmScoreB: result.tmScoreB,
    alignedLength: result.alignedLength,
    referenceAtoms: reference.atoms,
    targetAtoms: target.atoms,
  }
}

/**
 * Insert or update the Mol* decorator that moves one structure. The decorator
 * is the sole child of the structure cell, so later components attach below it
 * and render the transformed coordinates.
 */
async function applyStructureTransform(plugin: PluginContext, entry: SceneEntry, matrix: Mat4): Promise<void> {
  const params = {
    transform: {
      name: 'matrix' as const,
      params: { data: matrix, transpose: false },
    },
  }
  const existing = plugin.state.data.selectQ(
    q => q.byRef(entry.cellRef).subtree().withTransformer(StateTransforms.Model.TransformStructureConformation),
  )[0]
  const tree = existing === undefined
    ? plugin.state.data.build()
      .to(entry.cellRef)
      .insert(StateTransforms.Model.TransformStructureConformation, params, { tags: ['mol4agent-align'] })
    : plugin.state.data.build().to(existing).update(params)
  await plugin.runTask(plugin.state.data.updateTree(tree))
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
