// Player entry. Two paths from here:
//
//   - `?unregister=1` → escape hatch: tear down SW + caches, show a
//     confirmation message, do NOT mount React. If the player is ever
//     taken down or fundamentally broken, users would otherwise be
//     stuck with a registered SW + caches eating disk.
//
//   - Otherwise → mount React; PlayerPage owns the rest.

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { PlayerPage } from '#/web/pages/PlayerPage.tsx'
import { CACHE_NAME } from '#/web/player/cache.ts'
import { getT } from '#/web/lib/i18n.ts'

window.addEventListener('error', (e) => {
  console.error('[window.error]', e.message, e.error)
})
window.addEventListener('unhandledrejection', (e) => {
  console.error('[unhandledrejection]', e.reason)
})

if (new URLSearchParams(location.search).get('unregister') === '1') {
  void runEscapeHatch()
} else {
  const root = document.getElementById('root')
  if (!root) throw new Error('#root not found in player/index.html')
  createRoot(root).render(
    <StrictMode>
      <PlayerPage />
    </StrictMode>,
  )
}

async function runEscapeHatch(): Promise<void> {
  const t = getT()
  const root = document.getElementById('root')
  if (root) {
    root.innerHTML = `
      <div style="max-width: 480px; margin: 80px auto; padding: 0 24px; font-family: var(--font-sans); text-align: center;">
        <h1 style="font-size: 24px; margin: 0 0 12px;">Deck Player</h1>
        <p id="status" style="color: var(--color-mute); font-size: 14px;"></p>
      </div>
    `
    const status = document.getElementById('status')
    if (status) status.textContent = t('unregisterStatus')
  }

  const errors: unknown[] = []
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations()
      await Promise.all(
        regs.map((r) =>
          r.unregister().catch((e: unknown) => {
            errors.push(e)
          }),
        ),
      )
    }
  } catch (err) {
    errors.push(err)
  }
  try {
    if (typeof caches !== 'undefined') await caches.delete(CACHE_NAME)
  } catch (err) {
    errors.push(err)
  }
  try {
    localStorage.removeItem('deck-cache-lru-v2')
  } catch (err) {
    errors.push(err)
  }

  if (errors.length) console.error('Cleanup errors:', errors)

  const status = document.getElementById('status')
  if (status) {
    status.textContent = errors.length ? t('unregisterPartial') : t('unregisterDone')
  }
}
