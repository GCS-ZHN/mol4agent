/**
 * Vite build for the GUI part (`./gui-experimental`).
 *
 * The `gui()` preset from `@opencode/plugin/gui/vite` compiles Solid JSX with
 * `vite-plugin-solid`, emits one CommonJS file with inlined dynamic imports,
 * and keeps the app's shared modules external. Two additions:
 *
 * - `cssAsText`: core imports Mol*'s theme CSS as a default-exported string
 *   (`import css from 'molstar/.../light.css'`); Vite's default CSS pipeline
 *   does not provide a string default export, so `.css` files are loaded as
 *   text and re-exported as a JS string module.
 * - React alias: core/Mol* pull React; force a single React 18 instance.
 */
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { gui } from '@opencode/plugin/gui/vite'

const require = createRequire(import.meta.url)
const root = dirname(dirname(fileURLToPath(import.meta.url)))

function cssAsText() {
  return {
    name: 'css-as-text',
    enforce: 'pre' as const,
    async resolveId(source: string, importer: string | undefined) {
      // core imports Mol*'s theme CSS as a default-exported string. Redirect it
      // through Vite's `?inline` query, which returns the raw CSS text instead
      // of extracting it.
      if (source.endsWith('.css') && !source.includes('?')) {
        const resolved = await this.resolve(source, importer, { skipSelf: true })
        if (resolved) return resolved.id + '?inline'
      }
    },
  }
}

export default defineConfig({
  plugins: [
    gui({ entry: 'src/gui/gui.tsx', outFile: 'dist/gui.cjs' }),
    cssAsText(),
  ],
  resolve: {
    alias: {
      react: dirname(require.resolve('react/package.json')),
      'react-dom': dirname(require.resolve('react-dom/package.json')),
    },
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
})
