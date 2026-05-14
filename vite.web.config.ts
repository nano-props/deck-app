import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
import path from 'node:path'

/**
 * Vite config for the public web site (`src/web/`) — the marketing
 * homepage and the in-browser deck player.
 *
 * Separate from `vite.config.ts` (which builds the Electron renderer)
 * because the two targets diverge on almost every meaningful axis:
 * file:// vs http:// loading, strict CSP vs default, inline assets vs
 * hashed chunks, no SW vs SW. Sharing one config would mean a thicket
 * of `mode === 'web'` branches; two files keeps each target legible.
 *
 * Run via `vite build --config vite.web.config.ts` (see package.json
 * `build:web` script).
 *
 * MPA layout: two HTML entries (`index.html` for the homepage,
 * `player/index.html` for the player) plus a Service Worker entry
 * (`sw.ts`) that must emit at a stable filename — see comments below.
 *
 * `base: './'` so the bundled `<script>` / `<link>` tags resolve
 * against whichever directory the user deploys to (root, `/deck/`,
 * GitHub Pages project subpath, etc.).
 */
export default defineConfig({
  plugins: [react(), tailwind()],
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
        // SW lives at the same level as the HTML entries so its scope
        // covers both pages — only the player actually registers it,
        // but the file must sit at the deployment root for `scope: './'`
        // to mean "everything under this site". See sw.ts header.
        sw: path.resolve(import.meta.dirname, 'src/web/sw.ts'),
      },
      output: {
        // The SW URL is a literal string baked into sw-client.ts
        // (`./sw.js`). It must (a) sit next to the page that registers
        // it (only the player does, so the SW lands in `player/sw.js`)
        // and (b) keep its filename stable across builds — rollup's
        // default hashing would break the literal registration URL.
        // The if/else below pins the SW; everything else gets hashed
        // names so deploys bust browser cache cleanly.
        entryFileNames: (chunk) =>
          chunk.name === 'sw' ? 'player/sw.js' : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  // The SW is a classic worker (no `{type: 'module'}`) — keeps it
  // compatible with older browsers and avoids ESM-in-SW gotchas. Rollup
  // emits it as one file because nothing else imports it.
})
