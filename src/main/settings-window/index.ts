// Standalone Settings BrowserWindow.
//
// Singleton: openSettingsWindow() focuses the existing window (and pushes
// the requested tab) instead of spawning a second one. Top-level — not
// parented to any AppWindow — so it survives every AppWindow being
// closed, matching the VS Code / browser-Settings UX the user picked.
//
// Loads `settings.html` — a separate Vite entry from `index.html` so
// the route is decided by which file we ask the BrowserWindow to load,
// not by hash inspection at runtime. The initial tab is passed via
// hash (a deep-link, not a route discriminator); the renderer reads it
// once on mount and clears it.
//
// `flush-protocol.ts` is the only sub-module: it owns the pre-close
// handshake (main → renderer "commit pending edits" round-trip) which
// has enough wire-format detail to read better in isolation.

import { BrowserWindow } from 'electron'
import { t } from '#/main/i18n/index.ts'
import { CHROME_PRELOAD, SETTINGS_HTML, appCanvasBg, sharedWebPreferences, APP_ICON } from '#/main/window-shell.ts'
import {
  broadcastToChromeWebContents,
  registerAuxChromeWebContents,
  unregisterAuxChromeWebContents,
} from '#/main/window-registry.ts'
import {
  flushSettingsWindow,
  forgetSettingsWindowReady,
  notifyFlushFailed,
  trustSettingsWindow,
} from '#/main/settings-window/flush-protocol.ts'

export type SettingsTab = 'appearance' | 'ai' | 'about'

let singleton: BrowserWindow | null = null

/** True if the Settings window is currently open (and not destroyed). */
export function isSettingsWindowOpen(): boolean {
  return !!singleton && !singleton.isDestroyed()
}

/**
 * Close the Settings window if open. The window's own `close` handler
 * runs the flush protocol (so direct OS-button closes are equally
 * safe); we just trigger the close and wait for `closed` to fire.
 *
 * Resolves when the window is fully torn down.
 */
export function closeSettingsWindow(): Promise<void> {
  if (!singleton || singleton.isDestroyed()) return Promise.resolve()
  const win = singleton
  return new Promise((resolve) => {
    win.once('closed', () => resolve())
    win.close()
  })
}

/**
 * Open the Settings window, or focus the existing one. `tab` selects
 * which tab to land on; if the window is already open, we push the new
 * tab via IPC so the user lands where they expected.
 */
export function openSettingsWindow(tab: SettingsTab = 'appearance'): void {
  if (singleton && !singleton.isDestroyed()) {
    if (singleton.isMinimized()) singleton.restore()
    singleton.focus()
    sendTabToOpenWindow(singleton, tab)
    return
  }

  const win = new BrowserWindow({
    width: 720,
    height: 560,
    minWidth: 560,
    minHeight: 420,
    title: t('settings.title'),
    icon: APP_ICON,
    backgroundColor: appCanvasBg(),
    // Standard OS-decorated window — we don't need our custom topbar
    // overlay here. A native titlebar is the right idiom for a
    // Preferences window across platforms.
    titleBarStyle: 'default',
    // Don't show until first paint so users never see a white flash.
    show: false,
    resizable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      ...sharedWebPreferences,
      preload: CHROME_PRELOAD,
      // Same as AppWindow's chromeView — our preload requires npm modules.
      sandbox: false,
    },
  })

  // Cache the WebContents id NOW, before any close path could destroy
  // the underlying object. By the time `closed` fires, `win.webContents`
  // is already torn down and `.id` throws "Object has been destroyed"
  // — same pattern as AppWindow.handleClosed.
  const wcId = win.webContents.id

  singleton = win
  registerAuxChromeWebContents(wcId)
  // Authorize this wcId for the flush protocol. `chromeOnly` already
  // gates handler IPCs to chrome WCs in general, but the flush channels
  // use raw `ipcMain.on/once` and additionally restrict to *this*
  // window — no AppWindow chrome should be able to fake a ready ack
  // or a flush-done.
  trustSettingsWindow(wcId)

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show()
  })

  // Intercept `close` so the flush protocol runs for every close path
  // (OS red-dot, Cmd+W, menu, app quit), not just routes through
  // closeSettingsWindow. `flushing` drops re-entrant closes while the
  // first flush is in flight — without it a user smashing the button
  // would invoke every registered flusher N times.
  let flushing = false
  let flushed = false
  win.on('close', (event) => {
    if (flushed) return
    event.preventDefault()
    if (flushing) return
    flushing = true
    void flushSettingsWindow(win).then((result) => {
      // Surface flush failures (e.g. keychain unavailable) so the user
      // isn't silently left with a "saved key" they never actually
      // saved. Information-only — we still proceed to close, since
      // blocking the close path on a transient OS-level write failure
      // creates worse UX than telling the user.
      if (!result.ok) notifyFlushFailed(result.errors)
      flushed = true
      if (!win.isDestroyed()) win.close()
    })
  })

  win.on('closed', () => {
    unregisterAuxChromeWebContents(wcId)
    forgetSettingsWindowReady(wcId)
    if (singleton === win) singleton = null
    // Tell every remaining chrome surface to re-probe AI readiness — the
    // user may have added/removed a key in the AI tab. Mirrors what the
    // old in-window modal did via useAiStore.refreshReadiness on close.
    broadcastToChromeWebContents('app:ai-readiness-refresh')
  })

  // Hash carries the initial tab; SettingsApp consumes it once on mount.
  void win.loadFile(SETTINGS_HTML, { hash: tab })
}

/**
 * Push a tab id to the already-open Settings window. If the window is
 * still loading its first paint, queue the send to fire after
 * `did-finish-load` — `webContents.send` is dropped silently when the
 * renderer hasn't registered its IPC listener yet, which would manifest
 * as "user clicked menu → About but the window stayed on Appearance"
 * during a fast double-invoke.
 */
function sendTabToOpenWindow(win: BrowserWindow, tab: SettingsTab): void {
  const wc = win.webContents
  if (wc.isDestroyed()) return
  if (wc.isLoading()) {
    wc.once('did-finish-load', () => {
      if (wc.isDestroyed()) return
      try {
        wc.send('app:settings-window-set-tab', tab)
      } catch {
        // teardown race
      }
    })
    return
  }
  try {
    wc.send('app:settings-window-set-tab', tab)
  } catch {
    // teardown race
  }
}
