/**
 * Browser entry for the real-WebGL multi-structure smoke test.
 *
 * Built by `ui.test.mjs` with esbuild; not part of the package build. It loads
 * two PD-L1 structures, styles them differently, aligns chain B onto chain A,
 * exercises structure-scoped selection and visibility, and reports diagnostics.
 */
import { createMolViewer } from '../src/index.ts'

const host = document.getElementById('host') as HTMLDivElement
const status = document.getElementById('status') as HTMLDivElement

function base64(bytes: Uint8Array): string {
  const chunk = 0x8000
  let binary = ''
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + chunk, bytes.length)))
  }
  return btoa(binary)
}

async function run(): Promise<void> {
  const viewer = await createMolViewer({ container: host, theme: 'light' })
  const referencePdb = await (await fetch('/7czd.pdb')).text()
  const targetPdb = await (await fetch('/4zqk.pdb')).text()

  const reference = await viewer.load(
    { data: referencePdb, format: 'pdb', label: '7czd.pdb' },
    { id: 'reference' },
  )
  const added = await viewer.addStructure(
    { data: targetPdb, format: 'pdb', label: '4zqk.pdb' },
    { id: 'target' },
  )
  const styleReference = await viewer.execute({
    op: 'represent',
    style: { type: 'cartoon', color: 'uniform', colorParams: { value: 0x3b82f6 } },
  })
  const styleTarget = await viewer.execute({
    op: 'represent',
    replace: false,
    style: { type: 'cartoon', color: 'uniform', colorParams: { value: 0xef4444 } },
    target: { kind: 'all', structureId: 'target' },
  })
  // Issue #31: replacing chain B must not erase the cartoon on chain A.
  const replaceTarget = await viewer.execute({
    op: 'represent',
    style: { type: 'ball-and-stick', color: 'uniform', colorParams: { value: 0xef4444 } },
    target: { kind: 'chain', chain: 'B', structureId: 'reference' },
  })
  const inspectReferenceA = viewer.inspect({
    target: { kind: 'chain', chain: 'A', structureId: 'reference' },
    detail: 'summary',
  })
  const inspectReferenceB = viewer.inspect({
    target: { kind: 'chain', chain: 'B', structureId: 'reference' },
    detail: 'summary',
  })
  const tmscoreBefore = viewer.tmScore({
    reference: { kind: 'chain', chain: 'B', structureId: 'reference' },
    target: { kind: 'chain', chain: 'A', structureId: 'target' },
  })
  const align = await viewer.execute({
    op: 'align',
    reference: 'reference',
    target: 'target',
    method: 'tm-align',
    referenceChain: 'B',
    targetChain: 'A',
  })
  const sequence = await viewer.execute({
    op: 'align',
    reference: 'reference',
    target: 'target',
    method: 'sequence',
    referenceChain: 'B',
    targetChain: 'A',
  })
  const inspected = viewer.inspect({
    target: { kind: 'chain', chain: 'A', structureId: 'target' },
    detail: 'summary',
  })
  const tmscore = viewer.tmScore({
    reference: { kind: 'chain', chain: 'B', structureId: 'reference' },
    target: { kind: 'chain', chain: 'A', structureId: 'target' },
  })
  const select = await viewer.execute({
    op: 'select',
    target: { kind: 'chain', chain: 'A', structureId: 'target' },
    mode: 'highlight',
  })
  const hidden = await viewer.execute({ op: 'visibility', structureId: 'target', visible: false })
  const shown = await viewer.execute({ op: 'visibility', structureId: 'target', visible: true })
  const focus = await viewer.execute({ op: 'focus' })

  // Let Mol* present the final frame before the screenshot.
  await new Promise(resolve => { setTimeout(resolve, 1500) })
  const png = await viewer.capture({ width: 800, height: 600 })
  const diagnostics = viewer.diagnostics()
  const list = viewer.listStructures()
  const removed = await viewer.execute({ op: 'remove-structure', structureId: 'target' })
  const afterRemove = viewer.listStructures()
  const afterRemoveDiagnostics = viewer.diagnostics()

  await fetch('/result', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      reference,
      added,
      styleReference,
      styleTarget,
      replaceTarget,
      inspectReferenceA,
      inspectReferenceB,
      tmscoreBefore,
      align,
      sequence,
      tmscore,
      inspected,
      select,
      hidden,
      shown,
      focus,
      diagnostics,
      list,
      removed,
      afterRemove,
      afterRemoveDiagnostics,
      png: base64(png),
    }),
  })
  status.textContent = 'done'
}

run().catch(async reason => {
  const message = reason instanceof Error ? reason.stack ?? reason.message : String(reason)
  await fetch('/result', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ error: message }),
  }).catch(() => {})
  status.textContent = message
})
