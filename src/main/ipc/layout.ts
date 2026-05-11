import { ipcMain } from 'electron'
import { chromeOnly } from '#/main/ipc/guard.ts'
import {
  allAppWindows,
  appWindowByWebContents,
  broadcastToChromeWebContents,
} from '#/main/window-registry.ts'
import { openSettingsWindow, type SettingsTab } from '#/main/settings-window/index.ts'

const SETTINGS_TABS: readonly SettingsTab[] = ['appearance', 'ai', 'about']

/**
 * Chrome / layout side-channels. Pure visual state with no deck/AI
 * implications — kept separate so it's obvious which handlers are safe
 * to call outside deck mode.
 *
 * Channels:
 *   app:set-preview-bounds      — renderer-driven deckView geometry (the
 *                                 only path that mutates deckView bounds)
 *   app:set-chrome-theme        — propagate light/dark to the titleBarOverlay
 *                                 and broadcast so other windows resync.
 *   app:capture-deck-view       — snapshot the deckView (consumed by AI
 *                                 tool runs that include a preview image)
 *   app:toggle-fullscreen       — flip the focused window's native
 *                                 fullscreen state
 *   app:toggle-presentation     — drive deckView in/out of HTML5
 *                                 fullscreen (Player's Maximize button)
 *   app:open-settings-window    — open / focus the standalone Settings
 *                                 BrowserWindow. Optional `tab` payload.
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
      // The sender's own AppWindow (if any) gets its titleBarOverlay
      // recolored. The change may have come from the Settings window —
      // in that case there's no associated AppWindow, so we walk every
      // AppWindow and apply the theme to each of their overlays.
      const sender = appWindowByWebContents(event.sender)
      if (sender) {
        sender.applyChromeTheme(theme)
      } else {
        for (const w of allAppWindows()) {
          if (w.isDestroyed()) continue
          w.applyChromeTheme(theme)
        }
      }
      // Tell every other registered chrome WebContents to re-read its
      // theme. localStorage is shared across same-origin BrowserWindows,
      // but each renderer's React store is independent; a notification
      // wakes them up to apply the new value. We skip the sender — it
      // already owns the new state.
      broadcastToChromeWebContents('app:theme-changed', [theme], { excludeId: event.sender.id })
    }),
  )
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
  ipcMain.handle(
    'app:open-settings-window',
    chromeOnly((_event, tab: unknown) => {
      const t = SETTINGS_TABS.includes(tab as SettingsTab) ? (tab as SettingsTab) : 'appearance'
      openSettingsWindow(t)
    }),
  )
}
