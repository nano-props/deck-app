// Renderer entry for the standalone Settings BrowserWindow.
//
// Separate from `main.tsx` so the route is decided at the HTML level
// (which file the BrowserWindow loaded) rather than via runtime hash
// inspection. Two consequences:
//
//   1. No `isSettingsRoute` branching anywhere — each entry only pulls
//      what it actually needs (i18n + theme stores here; deck-runtime
//      stores are excluded entirely, not just dynamically skipped).
//   2. The hash is freed up for its conventional use — deep-linking to
//      a tab. main can still pass an initial tab via `loadFile`'s
//      `hash` option, but the renderer treats it as advisory state,
//      not as the route discriminator.
//
// The main process owns when/how this window opens; see
// `src/main/settings-window/index.ts`.

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

// Side-effect imports — each store wires its own IPC listener on load.
import '#/renderer/stores/i18n.ts'
import '#/renderer/stores/theme.ts'

import { SettingsApp } from '#/renderer/components/SettingsApp.tsx'
import { flushAll } from '#/renderer/lib/flush-registry.ts'

window.addEventListener('error', (e) => {
  console.error('[settings.error]', e.message, e.error)
})
window.addEventListener('unhandledrejection', (e) => {
  console.error('[settings.unhandledrejection]', e.reason)
})

// Wire the flush protocol BEFORE rendering. AiTab and any future tab
// register their flushers via flush-registry; main pings us through
// this IPC before destroying the window so we get a chance to commit
// pending edits (debounced save, un-blurred apiKey). Living here
// rather than inside SettingsApp keeps the React tree unaware of
// teardown plumbing — the registry is the seam.
//
// The handler returns flushAll's FlushResult so preload can forward
// errors (e.g. keychain unavailable) back to main and let it prompt
// the user before destroying the window.
window.deck.onFlushRequest?.(() => flushAll())

const root = document.getElementById('root')
if (!root) throw new Error('#root not found in settings.html')

createRoot(root).render(
  <StrictMode>
    <SettingsApp />
  </StrictMode>,
)
