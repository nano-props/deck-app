import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
import path from 'node:path'

/**
 * Vite config for the renderer (React).
 *
 * We don't run a dev server — the chromeView loads from `file://` so the
 * existing CSP (`script-src 'self'`) stays clean. Instead `vite build
 * --watch` rebuilds into `dist/renderer/` and the user reloads
 * (Cmd/Ctrl+R) to pick up changes. Main process is still tsx-watched
 * separately.
 *
 * Relative `base` so the bundled `<script>` / `<link>` tags resolve
 * against the file:// URL of `index.html`.
 */
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwind()],
  // Renderer source root — index.html lives here.
  root: path.resolve(import.meta.dirname, 'src/renderer'),
  base: './',
  resolve: {
    alias: {
      // Same `#/*` alias the rest of the project uses, so `t()` keys etc.
      // can be imported from the i18n dictionaries by absolute path.
      '#': path.resolve(import.meta.dirname, 'src'),
    },
  },
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/renderer'),
    emptyOutDir: true,
    // Inline sourcemap in development so the chromeView's DevTools can
    // map back to TS sources. Suppress in production — inline maps
    // survive electron-builder's `!**/*.map` filter (they're embedded
    // in the .js, not separate files), and would otherwise inflate the
    // packaged bundle by megabytes and ship the full source tree to
    // end users.
    //
    // Mode plumbing: `vite build` defaults to mode=production; the
    // `dev` npm script passes `--mode development` explicitly to
    // `vite build --watch` so this branch flips. `vite build` (no
    // flags) used by `build:renderer` / electron-builder stays in
    // production mode automatically.
    sourcemap: mode === 'production' ? false : 'inline',
    rollupOptions: {
      input: path.resolve(import.meta.dirname, 'src/renderer/index.html'),
    },
  },
}))
