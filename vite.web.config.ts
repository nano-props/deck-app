import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
import ts from 'typescript'
import path from 'node:path'
import fs from 'node:fs/promises'

/**
 * Dev-only: serve `src/web/sw.ts` at `/player/sw.js`. In build, rollup
 * emits the SW there via `rollupOptions.input`; in dev, without this
 * middleware Vite's SPA fallback returns `index.html` (text/html) and
 * Chrome refuses to register a SW with that MIME.
 */
function devServeServiceWorker(): Plugin {
  const swSource = path.resolve(import.meta.dirname, 'src/web/sw.ts')
  return {
    name: 'deck-app:dev-serve-sw',
    apply: 'serve',
    configureServer(server) {
      // connect's `use(path, ...)` matches by prefix, which would also
      // catch `/player/sw.js.map`, `/player/sw.jsx`, etc. Match exactly
      // so unrelated paths fall through to Vite's normal handling.
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ? req.url.split('?')[0] : ''
        if (url !== '/player/sw.js') return next()
        try {
          const source = await fs.readFile(swSource, 'utf8')
          // The bare `export {}` in sw.ts only exists so `declare` type-
          // checks. We strip it (and use `module: Preserve`) so TS emits
          // plain script-mode JS — under any module kind that TS picks
          // by default for an ESM file, the output references an
          // `exports` global the classic SW doesn't have.
          const stripped = source.replace(/^\s*export\s*\{\s*\}\s*;?\s*$/gm, '')
          const result = ts.transpileModule(stripped, {
            compilerOptions: {
              target: ts.ScriptTarget.ESNext,
              module: ts.ModuleKind.Preserve,
              inlineSourceMap: true,
              inlineSources: true,
            },
            fileName: 'sw.ts',
          })
          res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
          res.setHeader('Cache-Control', 'no-store')
          res.end(result.outputText)
        } catch (err) {
          next(err as Error)
        }
      })
    },
  }
}

/**
 * Vite config for the public web site (`src/web/`) — marketing
 * homepage and in-browser deck player. Separate from `vite.config.ts`
 * (Electron renderer) because the two targets diverge on file:// vs
 * http://, CSP, inline vs hashed assets, and SW presence — sharing
 * would mean `mode === 'web'` branches everywhere.
 *
 * `base: './'` so bundled tags resolve against whichever directory
 * the user deploys to (root, `/deck/`, GitHub Pages subpath, etc.).
 */
export default defineConfig({
  plugins: [react(), tailwind(), devServeServiceWorker()],
  root: path.resolve(import.meta.dirname, 'src/web'),
  base: './',
  resolve: {
    alias: {
      '#': path.resolve(import.meta.dirname, 'src'),
    },
  },
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/web'),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        index: path.resolve(import.meta.dirname, 'src/web/index.html'),
        player: path.resolve(import.meta.dirname, 'src/web/player/index.html'),
        sw: path.resolve(import.meta.dirname, 'src/web/sw.ts'),
      },
      output: {
        // sw-client.ts hardcodes `./sw.js` as the registration URL, so
        // the SW must land at `player/sw.js` (next to the player page)
        // with a stable, unhashed name.
        entryFileNames: (chunk) =>
          chunk.name === 'sw' ? 'player/sw.js' : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
})
