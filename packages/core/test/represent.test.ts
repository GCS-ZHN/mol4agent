/**
 * Real Mol* hierarchy tests for the `represent` replace/overlay semantics.
 *
 * A headless `PluginContext` builds the same state tree the viewer uses, so
 * these tests assert the representation set Mol* actually keeps instead of a
 * mock's call log. No canvas or WebGL is needed: only components and their
 * representation transforms.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { PluginContext } from 'molstar/lib/mol-plugin/context.js'
import { DefaultPluginSpec } from 'molstar/lib/mol-plugin/spec.js'
import { applyRepresentation } from '../src/represent.ts'
import type { RepresentCommand } from '../src/protocol.ts'

const fixture = (name: string): string => readFileSync(new URL(`../../../fixtures/${name}`, import.meta.url), 'utf8')

async function load(name: string): Promise<PluginContext> {
  const plugin = new PluginContext(DefaultPluginSpec())
  await plugin.init()
  const data = await plugin.builders.data.rawData({ data: fixture(name), label: name })
  const trajectory = await plugin.builders.structure.parseTrajectory(data as never, 'pdb')
  const model = await plugin.builders.structure.createModel(trajectory)
  await plugin.builders.structure.createStructure(model)
  return plugin
}

function styleKey(plugin: PluginContext): string[] {
  const styles: string[] = []
  for (const structure of plugin.managers.structure.hierarchy.current.structures) {
    for (const component of structure.components) {
      const label = component.cell.obj?.label ?? 'component'
      for (const representation of component.representations) {
        const values = representation.cell.params?.values as {
          type?: { name?: string }
          colorTheme?: { name?: string }
        } | undefined
        styles.push(`${label}:${values?.type?.name}/${values?.colorTheme?.name}`)
      }
    }
  }
  return styles.sort()
}

function componentLabels(plugin: PluginContext): string[] {
  return plugin.managers.structure.hierarchy.current.structures
    .flatMap(structure => structure.components.map(component => component.cell.obj?.label ?? 'component'))
    .sort()
}

async function apply(plugin: PluginContext, command: RepresentCommand): Promise<void> {
  const result = await applyRepresentation(plugin, command)
  assert.equal(result.ok, true, result.ok ? '' : result.message)
}

test('replace: true replaces a cartoon preset with a non-preset style and back', async t => {
  const plugin = await load('1crn.pdb')
  t.after(() => plugin.dispose())

  await apply(plugin, { op: 'represent', style: { type: 'cartoon', color: 'chain-id' } })
  assert.deepEqual(styleKey(plugin), ['Polymer:cartoon/chain-id'])

  await apply(plugin, { op: 'represent', style: { type: 'ball-and-stick', color: 'uniform', colorParams: { value: 'red' } } })
  assert.deepEqual(styleKey(plugin), ['mol4agent global:ball-and-stick/uniform'])
  assert.deepEqual(componentLabels(plugin), ['mol4agent global'])

  await apply(plugin, { op: 'represent', style: { type: 'cartoon', color: 'uniform', colorParams: { value: 'blue' } } })
  assert.deepEqual(styleKey(plugin), ['Polymer:cartoon/uniform'])
})

test('replace: false overlays a non-preset style on a cartoon preset', async t => {
  const plugin = await load('1crn.pdb')
  t.after(() => plugin.dispose())

  await apply(plugin, { op: 'represent', style: { type: 'cartoon', color: 'chain-id' } })
  await apply(plugin, {
    op: 'represent',
    style: { type: 'ball-and-stick', color: 'uniform', colorParams: { value: 'red' } },
    replace: false,
  })
  assert.deepEqual(styleKey(plugin), [
    'Polymer:cartoon/chain-id',
    'mol4agent global:ball-and-stick/uniform',
  ])
})

test('replace: false adds the cartoon preset on top of an existing non-preset style', async t => {
  const plugin = await load('1crn.pdb')
  t.after(() => plugin.dispose())

  await apply(plugin, { op: 'represent', style: { type: 'ball-and-stick', color: 'element-symbol' } })
  await apply(plugin, { op: 'represent', style: { type: 'cartoon', color: 'chain-id' }, replace: false })
  assert.deepEqual(styleKey(plugin), [
    'Polymer:cartoon/chain-id',
    'mol4agent global:ball-and-stick/element-symbol',
  ])
})

test('replace: true with target clears the scene and covers only the target', async t => {
  const plugin = await load('1atp.pdb')
  t.after(() => plugin.dispose())

  await apply(plugin, { op: 'represent', style: { type: 'cartoon', color: 'chain-id' } })
  assert.ok(componentLabels(plugin).includes('Polymer'))

  await apply(plugin, {
    op: 'represent',
    style: { type: 'ball-and-stick', color: 'uniform', colorParams: { value: 'red' } },
    target: { kind: 'ligand' },
  })
  assert.deepEqual(styleKey(plugin), ['mol4agent selection:ball-and-stick/uniform'])
  assert.deepEqual(componentLabels(plugin), ['mol4agent selection'])
})

test('replace: false with target keeps the whole scene and adds the selection', async t => {
  const plugin = await load('1crn.pdb')
  t.after(() => plugin.dispose())

  await apply(plugin, { op: 'represent', style: { type: 'cartoon', color: 'chain-id' } })
  await apply(plugin, {
    op: 'represent',
    style: { type: 'ball-and-stick', color: 'uniform', colorParams: { value: 'red' } },
    target: { kind: 'residues', chain: 'A', start: 1, end: 5 },
    replace: false,
  })
  assert.deepEqual(styleKey(plugin), [
    'Polymer:cartoon/chain-id',
    'mol4agent selection:ball-and-stick/uniform',
  ])
})

test('replace: false stacks two styles on the same target', async t => {
  const plugin = await load('1crn.pdb')
  t.after(() => plugin.dispose())

  await apply(plugin, { op: 'represent', style: { type: 'cartoon', color: 'chain-id' } })
  await apply(plugin, {
    op: 'represent',
    style: { type: 'ball-and-stick', color: 'uniform', colorParams: { value: 'red' } },
    target: { kind: 'residues', chain: 'A', start: 1, end: 5 },
    replace: false,
  })
  await apply(plugin, {
    op: 'represent',
    style: { type: 'line', color: 'element-symbol' },
    target: { kind: 'residues', chain: 'A', start: 1, end: 5 },
    replace: false,
  })
  assert.deepEqual(styleKey(plugin), [
    'Polymer:cartoon/chain-id',
    'mol4agent selection:ball-and-stick/uniform',
    'mol4agent selection:line/element-symbol',
  ])
})

test('a later global replace removes an earlier targeted overlay', async t => {
  const plugin = await load('1crn.pdb')
  t.after(() => plugin.dispose())

  await apply(plugin, { op: 'represent', style: { type: 'cartoon', color: 'chain-id' } })
  await apply(plugin, {
    op: 'represent',
    style: { type: 'ball-and-stick', color: 'uniform', colorParams: { value: 'red' } },
    target: { kind: 'residues', chain: 'A', start: 1, end: 5 },
    replace: false,
  })
  assert.ok(componentLabels(plugin).includes('mol4agent selection'))

  await apply(plugin, { op: 'represent', style: { type: 'cartoon', color: 'uniform', colorParams: { value: 'blue' } } })
  assert.deepEqual(styleKey(plugin), ['Polymer:cartoon/uniform'])
  assert.deepEqual(componentLabels(plugin), ['Polymer'])
})

test('a target that matches nothing fails without clearing the scene', async t => {
  const plugin = await load('1crn.pdb')
  t.after(() => plugin.dispose())

  await apply(plugin, { op: 'represent', style: { type: 'cartoon', color: 'chain-id' } })
  const result = await applyRepresentation(plugin, {
    op: 'represent',
    style: { type: 'ball-and-stick', color: 'uniform' },
    target: { kind: 'ligand' },
  })
  assert.equal(result.ok, false)
  assert.equal(result.ok ? undefined : result.code, 'REPRESENT_FAILED')
  assert.deepEqual(styleKey(plugin), ['Polymer:cartoon/chain-id'])
})

test('replace defaults to true when omitted', async t => {
  const plugin = await load('1crn.pdb')
  t.after(() => plugin.dispose())

  await apply(plugin, { op: 'represent', style: { type: 'cartoon', color: 'chain-id' } })
  await apply(plugin, { op: 'represent', style: { type: 'line', color: 'element-symbol' } })
  assert.deepEqual(styleKey(plugin), ['mol4agent global:line/element-symbol'])
})
