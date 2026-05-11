// Renderer entry for the deck AppWindow (launcher / editor / player).
//
// The standalone Settings BrowserWindow has its own entry —
// `settings.html` + `settings-main.tsx`. Each entry imports only the
// stores it needs, so there's no route-branch logic at the renderer
// level: the BrowserWindow's choice of HTML file IS the route.

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

// Side-effect imports — each store wires its own IPC listener on load.
// `ai-events` must come AFTER the chat/ai/attachment stores so its
// dispatch hits the already-initialized store instances.
import '#/renderer/stores/app.ts'
import '#/renderer/stores/i18n.ts'
import '#/renderer/stores/theme.ts'
import '#/renderer/stores/ai.ts'
import '#/renderer/stores/chat.ts'
import '#/renderer/stores/attachments.ts'
import '#/renderer/stores/ai-events.ts'

import { App } from '#/renderer/App.tsx'

window.addEventListener('error', (e) => {
  console.error('[window.error]', e.message, e.error)
})
window.addEventListener('unhandledrejection', (e) => {
  console.error('[unhandledrejection]', e.reason)
})

const root = document.getElementById('root')
if (!root) throw new Error('#root not found in index.html')
// StrictMode is dev-only (stripped in production). It mounts each
// component twice on first render to surface effects that aren't
// idempotent / lack proper cleanups. All current effects have been
// audited to handle the double-fire safely (dedup'd ResizeObserver
// pushes, debounced localStorage writes, ipcRenderer.off cleanups).
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
