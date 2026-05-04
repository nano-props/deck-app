import { ipcMain } from 'electron'
import { chromeOnly } from '#/main/ipc/guard.ts'
import { appWindowByWebContents } from '#/main/window-registry.ts'

/**
 * Chrome / layout side-channels. Pure visual state with no deck/AI
 * implications — kept separate so it's obvious which handlers are safe
 * to call outside deck mode.
 *
 * Channels:
 *   app:set-chat-width          — persist the editor's chat-pane width
 *   app:set-chrome-theme        — propagate light/dark to the titleBarOverlay
 *   app:set-deck-view-visible   — hide the native WebContentsView under modal overlays
 */
export function wireLayoutIpc(): void {
  ipcMain.handle(
    'app:set-chat-width',
    chromeOnly((event, px: unknown) => {
      if (typeof px !== 'number' || !Number.isFinite(px)) return
      const w = appWindowByWebContents(event.sender)
      w?.setChatWidth(px)
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
}
