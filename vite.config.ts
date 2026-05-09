import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, 'package.json'), 'utf8'),
) as { version: string; devDependencies?: Record<string, string> }

// Best-effort git commit hash — short form. Failing silently (no git, shallow
// clone, build server without git) just yields an empty string; the About
// tab shows a dash in that case rather than a broken build.
function commitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: import.meta.dirname })
      .toString()
      .trim()
  } catch {
    return ''
  }
}

// Electron version comes from devDependencies — pinning, so the string in
// package.json (e.g. "^33.0.0") is what ships. Strip leading range chars.
function electronVersion(): string {
  const raw = pkg.devDependencies?.electron ?? ''
  return raw.replace(/^[\^~>=<\s]+/, '')
}

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
  // Inject app version at build time so the renderer can show it (e.g. in
  // the About tab) without a round-trip to the main process. JSON.stringify
  // so the value lands as a string literal, not bare text.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_INFO__: JSON.stringify({
      commit: commitHash(),
      electron: electronVersion(),
      // Build timestamp — ISO so the renderer can format per-locale.
      builtAt: new Date().toISOString(),
    }),
  },
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
