/**
 * Browser entry for the DSH document-body smoke test.
 *
 * Renders `MolBody` directly with fake DSH hooks, a two-structure projection,
 * and a pending capture. It exercises the real bytes -> core -> Mol* path,
 * structure sync, TM-align, and the capture report without booting DSH.
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MolBody } from '../src/client/document.tsx'
import { sessionFileAddress } from '../src/client/address.ts'
import { encodeInspectAnswer } from '../src/client/inspect.ts'

const PATH = '/virtual/7czd.pdb'
const TARGET_PATH = '/virtual/4zqk.pdb'
const SESSION_ID = 'session-test'
const CAPTURE_ID = 'capture-test'

const scene = {
  sceneKey: `${PATH}#open`,
  path: PATH,
  format: 'pdb',
  label: '7czd.pdb',
  structures: [
    { id: 'structure', path: PATH, format: 'pdb', label: '7czd.pdb' },
    { id: 'target', path: TARGET_PATH, format: 'pdb', label: '4zqk.pdb' },
  ],
  commands: [
    { op: 'represent', style: { type: 'cartoon', color: 'chain-id' } },
    {
      op: 'represent',
      replace: false,
      style: { type: 'cartoon', color: 'uniform', colorParams: { value: 0xef4444 } },
      target: { kind: 'all', structureId: 'target' },
    },
    {
      op: 'align',
      reference: 'structure',
      target: 'target',
      method: 'tm-align',
      referenceChain: 'B',
      targetChain: 'A',
    },
    { op: 'select', target: { kind: 'chain', chain: 'A', structureId: 'target' }, mode: 'highlight' },
  ],
} as const

const projection = {
  revision: 2,
  tabs: { [PATH]: scene },
  active: PATH,
  pending: {
    [CAPTURE_ID]: { callId: CAPTURE_ID, path: PATH, width: 640, height: 480 },
  },
  pendingAligns: {
    'align-test': { callId: 'align-test', path: PATH, commandIndex: 2 },
  },
  inspecting: {
    'inspect-test': {
      callId: 'inspect-test',
      path: PATH,
      target: { kind: 'chain', chain: 'B', structureId: 'structure' },
      detail: 'summary',
    },
  },
  pendingTmScores: {
    'tm-test': {
      callId: 'tm-test',
      path: PATH,
      reference: { kind: 'chain', chain: 'B', structureId: 'structure' },
      target: { kind: 'chain', chain: 'A', structureId: 'target' },
    },
  },
}

const aborter = new AbortController()
const tab = { id: 'tab-test', signal: aborter.signal }

async function readBytes(path: string): Promise<Uint8Array> {
  const name = path.endsWith('4zqk.pdb') ? '4zqk.pdb' : '7czd.pdb'
  return new Uint8Array(await (await fetch(`/${name}`)).arrayBuffer())
}

const props = {
  sessionId: SESSION_ID,
  resourceAddress: sessionFileAddress(SESSION_ID, PATH),
  useTabInfo: () => ({ tab }),
  useResource: () => ({ value: { version: '1' } }),
  useProjection: () => projection,
  content: {
    kind: 'renderer' as const,
    revision: 1,
    loaded: () => {},
    failed: () => {},
  },
  readBytes: (path: string) => readBytes(path),
  addResource: () => {},
  subscribeTheme: (listener: (theme: 'light' | 'dark') => void) => {
    listener('light')
    return () => {}
  },
  t: (key: string) => key,
  deliverCapture: async (callId: string, png: Uint8Array, report: Record<string, unknown>) => {
    const binary = Array.from(png, byte => String.fromCharCode(byte)).join('')
    await fetch('/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callId, png: btoa(binary), report }),
    })
  },
  deliverInspect: async (callId: string, answer: unknown) => {
    const encoded = await encodeInspectAnswer(answer as never)
    await fetch('/inspect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callId, encoded }),
    })
  },
  deliverTmScore: async (callId: string, answer: unknown) => {
    await fetch('/tm-score', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callId, answer }),
    })
  },
  deliverAlignResult: async (callId: string, payload: unknown) => {
    await fetch('/align-result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callId, payload }),
    })
  },
}

const root = createRoot(document.getElementById('host') as HTMLDivElement)
root.render(createElement(MolBody as never, props as never))
