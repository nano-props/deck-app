import { ipcMain } from 'electron'
import { chromeOnly } from '#/main/ipc/guard.ts'
import { appWindowByWebContents } from '#/main/window-registry.ts'

/**
 * Chrome / layout side-channels. Pure visual state with no deck/AI
 * implications — kept separate so it's obvious which handlers are safe
 * to call outside deck mode.
 *
 * Channels:
 *   app:set-preview-bounds     — renderer-driven deckView geometry (the
 *                                only path that mutates deckView bounds)
 *   app:set-chrome-theme       — propagate light/dark to the titleBarOverlay
 *   app:set-deck-view-visible  — hide the native WebContentsView under modal overlays
 *   app:capture-deck-view      — snapshot the deckView so a modal can show it through a real translucent mask
 *   app:toggle-fullscreen      — flip the focused window's native fullscreen state
 *   app:toggle-presentation    — drive deckView in/out of HTML5 fullscreen (Player's Maximize button)
 */
export function wireLayoutIpc(): void {
  ipcMain.handle(
    'app:set-preview-bounds',
    chromeOnly((event, rect: unknown) => {
      if (!rect || typeof rect !== 'object') return
      const r = rect as { x?: unknown; y?: unknown; width?: unknown; height?: unknown }
      if (
        typeof r.x !== 'number' ||
        typeof r.y !== 'number' ||
        typeof r.width !== 'number' ||
        typeof r.height !== 'number'
      ) {
        return
      }
      const w = appWindowByWebContents(event.sender)
      w?.setPreviewBounds({ x: r.x, y: r.y, width: r.width, height: r.height })
    }),
  )
  ipcMain.handle(
    'app:set-chrome-theme',
    chromeOnly((event, theme: unknown) => {
      if (theme !== 'dark' && theme !== 'light') return
      const w = appWindowByWebContents(event.sender)
      w?.applyChromeTheme(theme)
    }),
  )
  // Renderer toggles this when a modal overlay (Settings, future
  // dialogs) opens / closes. The deckView draws above chromeView in
  // layer order, so full-window overlays in the chrome get clipped by
  // it. Hiding the deckView around the overlay's lifetime is the cheap
  // fix; modal state is short-lived so the preview black flash is fine.
  ipcMain.handle(
    'app:set-deck-view-visible',
    chromeOnly((event, visible: unknown) => {
      const w = appWindowByWebContents(event.sender)
      w?.setDeckViewVisible(!!visible)
    }),
  )
  // Returns a PNG data URL of the current deckView frame plus the bounds
  // it was painted at. Renderer paints an <img> at that rect under the
  // modal overlay so the translucent mask actually has the deck behind
  // it — instead of the chromeView's empty background.
  ipcMain.handle(
    'app:capture-deck-view',
    chromeOnly(async (event) => {
      const w = appWindowByWebContents(event.sender)
      if (!w) return null
      return await w.captureDeckView()
    }),
  )
  ipcMain.handle(
    'app:toggle-fullscreen',
    chromeOnly((event) => {
      appWindowByWebContents(event.sender)?.toggleFullScreen()
    }),
  )
  ipcMain.handle(
    'app:toggle-presentation',
    chromeOnly((event) => {
      appWindowByWebContents(event.sender)?.togglePresentation()
    }),
  )
}
