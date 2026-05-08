// React entry. Imports stores for their side-effect subscriptions, then
// mounts <App />.

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
createRoot(root).render(<App />)
