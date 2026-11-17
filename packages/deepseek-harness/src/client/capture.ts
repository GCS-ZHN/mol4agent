/**
 * Capture the viewport only after Mol* has presented the scene.
 *
 * A screenshot requested immediately after `mol_open` can read the freshly
 * allocated framebuffer before the first real frame is presented (observed on
 * Windows with ANGLE), yielding a background-only PNG even though the
 * diagnostics already report a loaded structure and representation. Wait for a
 * laid-out canvas, then retry while the image stays uniform. The last frame is
 * returned even when every attempt looked blank, so the capture rendezvous can
 * still report its diagnostics instead of timing out.
 *
 * @module @gcszhn/mol4agent-deepseekharness/client/capture
 */
import type { CaptureOptions, MolViewer } from '@gcszhn/mol4agent-core'

/** Attempts before returning the final frame even if it looked blank. */
const CAPTURE_ATTEMPTS = 3
/** How long to wait for a laid-out canvas with a representation. */
const LAYOUT_TIMEOUT_MS = 4_000
/** Let Mol* present the freshly applied representation before reading pixels. */
const SETTLE_MS = 250
/** Pause before re-reading a frame that only held the background. */
const RETRY_MS = 350
/** Downsampled size of the content check. */
const SAMPLE_WIDTH = 96
/** Fraction of sampled pixels that must differ from the top-left pixel. */
const MIN_CONTENT_RATIO = 0.005
/** Per-channel difference that counts as content. */
const PIXEL_DELTA = 24

/** A rendered PNG plus whether it held more than the background colour. */
export interface VisibleCapture {
  readonly png: Uint8Array
  readonly visible: boolean
}

/** Capture a PNG, waiting for and preferring a visibly rendered scene. */
export async function captureVisible(viewer: MolViewer, options: CaptureOptions): Promise<VisibleCapture> {
  let last: Uint8Array | undefined
  for (let attempt = 0; attempt < CAPTURE_ATTEMPTS; attempt += 1) {
    await waitForRenderable(viewer)
    last = await viewer.capture(options)
    if (await hasVisibleContent(last)) return { png: last, visible: true }
    await delay(RETRY_MS)
  }
  if (last === undefined) throw new Error('the viewer produced no image')
  return { png: last, visible: false }
}

async function waitForRenderable(viewer: MolViewer): Promise<void> {
  const deadline = Date.now() + LAYOUT_TIMEOUT_MS
  while (Date.now() < deadline) {
    // Nudges Mol* to resize and repaint a viewer that mounted before the
    // sidebar gave the tab a box.
    viewer.resize()
    const diagnostics = viewer.diagnostics()
    if (
      diagnostics.host.clientWidth > 0
      && diagnostics.host.clientHeight > 0
      && diagnostics.canvas.clientWidth > 0
      && diagnostics.canvas.clientHeight > 0
      // A representation is enough: `atoms` is 0 for BCIF, whose summary is
      // unsupported even though it renders.
      && diagnostics.representations > 0
    ) {
      await delay(SETTLE_MS)
      return
    }
    await delay(100)
  }
}

async function hasVisibleContent(png: Uint8Array): Promise<boolean> {
  if (typeof createImageBitmap !== 'function') return true
  let bitmap: ImageBitmap | undefined
  try {
    bitmap = await createImageBitmap(new Blob([png as unknown as BlobPart], { type: 'image/png' }))
    const width = SAMPLE_WIDTH
    const height = Math.max(1, Math.round((bitmap.height / bitmap.width) * width))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (context === null) return true
    context.drawImage(bitmap, 0, 0, width, height)
    const data = context.getImageData(0, 0, width, height).data
    const r0 = data[0] ?? 0
    const g0 = data[1] ?? 0
    const b0 = data[2] ?? 0
    const a0 = data[3] ?? 0
    let different = 0
    for (let index = 0; index < data.length; index += 4) {
      const delta = Math.abs((data[index] ?? 0) - r0)
        + Math.abs((data[index + 1] ?? 0) - g0)
        + Math.abs((data[index + 2] ?? 0) - b0)
        + Math.abs((data[index + 3] ?? 0) - a0)
      if (delta > PIXEL_DELTA) different += 1
    }
    return different / (width * height) >= MIN_CONTENT_RATIO
  } catch {
    return true
  } finally {
    bitmap?.close()
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, milliseconds) })
}
