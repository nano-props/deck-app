import { ipcMain } from 'electron'
import { chromeOnly } from '#/main/ipc/guard.ts'
import { allAppWindows, appWindowByWebContents } from '#/main/window-registry.ts'
import {
  applySettingsWindowChromeTheme,
  openSettingsWindow,
  type SettingsTab,
} from '#/main/settings-window/index.ts'
import { subscribeTheme } from '#/main/theme.ts'

const SETTINGS_TABS: readonly SettingsTab[] = ['appearance', 'ai', 'about']

/**
 * Chrome / layout side-channels. Pure visual state with no deck/AI
 * implications — kept separate so it's obvious which handlers are safe
 * to call outside deck mode.
 *
 * Channels:
 *   app:set-preview-bounds      — renderer-driven deckView geometry (the
 *                                 only path that mutates deckView bounds)
 *   app:capture-deck-view       — snapshot the deckView (consumed by AI
 *                                 tool runs that include a preview image)
 *   app:toggle-fullscreen       — flip the focused window's native
 *                                 fullscreen state
 *   app:toggle-presentation     — drive deckView in/out of HTML5
 *                                 fullscreen (Player's Maximize button)
 *   app:open-settings-window    — open / focus the standalone Settings
 *                                 BrowserWindow. Optional `tab` payload.
 *
 * Also subscribes to `theme.ts` once (no IPC channel of its own) to
 * recolor every window's `titleBarOverlay` when the user picks a new
 * theme or the OS appearance shifts under 'auto'. Recoloring lives in
 * main because `setTitleBarOverlay` is a `BaseWindow` API that
 * renderers can't reach.
 */
export function wireLayoutIpc(): void {
  subscribeTheme(({ resolved }) => {
    for (const w of allAppWindows()) {
      if (w.isDestroyed()) continue
      w.applyChromeTheme(resolved)
    }
    // No-op on macOS (settings window has no overlay there); paints
    // the caption-button strip on Win/Linux.
    applySettingsWindowChromeTheme(resolved)
  })

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
