import { app, BrowserWindow, dialog } from 'electron'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import {
  launcherChrome,
  launcherOverlayForTheme,
  playerChrome,
  supportsOverlayThemeUpdates,
} from '#/main/chrome-strategy.ts'
import { loadDeck, DeckLoadError } from '#/main/deck-loader.ts'
import type { DeckManifest } from '#/main/deck-types.ts'
import { startDeckServer } from '#/main/server.ts'
import { sessionManager } from '#/main/session-manager.ts'
import { installDragStrip } from '#/main/player-titlebar.ts'

// Both paths resolve inside the asar in packaged builds, so they must be
// kept in sync with `build.files` in package.json — `src/preload/**/*`
// and `src/renderer/**/*` respectively. If you rename or move either
// directory, update that glob too or the packaged app will silently lose
// its preload bridge (no `window.deckApp`) or fail to load the Launcher.
const LAUNCHER_PRELOAD = path.join(import.meta.dirname, '..', 'preload', 'launcher-preload.js')
const LAUNCHER_HTML = path.join(import.meta.dirname, '..', 'renderer', 'index.html')

/**
 * Icon lives under assets/ at the repo root during development and under
 * .app/Contents/Resources/assets/ after packaging (via `extraResources` in
 * electron-builder). `process.resourcesPath` gives us the Resources dir
 * in the packaged case; in dev we resolve from the project root.
 */
export const APP_ICON = app.isPackaged
  ? path.join(process.resourcesPath, 'assets', 'icon.png')
  : path.join(import.meta.dirname, '..', '..', 'assets', 'icon.png')

/**
 * Set a window's title bar overlay to match an explicit theme. No-op on
 * platforms whose chrome strategy doesn't use `titleBarOverlay` (macOS), and
 * on windows that weren't created with `titleBarStyle: 'hidden'`.
 */
export function applyChromeTheme(win: BrowserWindow, theme: 'dark' | 'light'): void {
  if (!supportsOverlayThemeUpdates || win.isDestroyed()) return
  try {
    win.setTitleBarOverlay(launcherOverlayForTheme(theme === 'dark'))
  } catch {
    // Throws if the window wasn't created with titleBarStyle: 'hidden'.
    // Safe to ignore — caller just doesn't get a theme swap.
  }
}

/**
 * Secure defaults shared by all windows. `preload` is deliberately not set
 * here — supplied per-window so author pages in the Player never see our
 * `window.deckApp` bridge (spec §4: no runtime API on the author window).
 */
const sharedWebPreferences = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
}

/** Tracks the live Launcher so repeated calls just focus it. */
let launcherWindow: BrowserWindow | null = null

/**
 * Show the Launcher. If one already exists, focus it (and un-minimize if
 * needed) instead of opening a second one. Dock icon clicks, menu-less
 * activations, and the argv-empty fallback all funnel through here.
 */
export function showLauncherWindow(): BrowserWindow {
  if (launcherWindow && !launcherWindow.isDestroyed()) {
    if (launcherWindow.isMinimized()) launcherWindow.restore()
    launcherWindow.focus()
    return launcherWindow
  }

  // Launcher is app chrome, so it uses the launcher preload (exposes
  // window.deckApp). Chrome options (titlebar style, overlay, menu bar) come
  // from the per-platform strategy — see src/main/chrome-strategy.ts.
  const win = new BrowserWindow({
    titleBarStyle: launcherChrome.titleBarStyle,
    titleBarOverlay: launcherChrome.initialOverlay(),
    autoHideMenuBar: launcherChrome.autoHideMenuBar,
    width: 900,
    height: 600,
    minWidth: 640,
    minHeight: 480,
    title: 'Deck',
    icon: APP_ICON,
    backgroundColor: '#fafaf9',
    webPreferences: {
      ...sharedWebPreferences,
      preload: LAUNCHER_PRELOAD,
    },
  })
  void win.loadFile(LAUNCHER_HTML)
  launcherWindow = win
  // The Launcher renderer owns theme state ("follow system until user picks",
  // persisted in localStorage) and reports it via `deck:set-chrome-theme` IPC,
  // which routes to `applyChromeTheme`. We deliberately do NOT subscribe to
  // `nativeTheme.updated` here — doing so would race with a user-persisted
  // theme choice (system flips → overlay flips back, even though the
  // renderer kept the user's pick).
  win.once('closed', () => {
    if (launcherWindow === win) launcherWindow = null
  })
  return win
}

export async function openDeckInNewWindow(deckPath: string): Promise<void> {
  // Resources accumulate in this order; on failure we unwind them
  // in reverse. Once `registered` flips true, ownership transfers to
  // the SessionManager (its 'closed' handler does the cleanup instead).
  let loaded: { rootDir: string; manifest: DeckManifest; ownsRootDir: boolean } | null = null
  let server: Awaited<ReturnType<typeof startDeckServer>> | null = null
  let win: BrowserWindow | null = null
  let registered = false

  try {
    loaded = await loadDeck(deckPath)
    server = await startDeckServer(loaded.rootDir)

    // Player is a pure playback surface: the menu bar is hidden so it
    // doesn't sandwich the slide (Launcher keeps its menu — that's where
    // users actually need File > Open). `show: false` avoids a blank
    // flash if loadURL fails. Per-platform chrome comes from the strategy
    // — see src/main/chrome-strategy.ts for rationale (macOS injects a
    // drag strip, Windows/Linux use titleBarOverlay).
    win = new BrowserWindow({
      show: false,
      titleBarStyle: playerChrome.titleBarStyle,
      titleBarOverlay: playerChrome.overlay,
      autoHideMenuBar: playerChrome.autoHideMenuBar,
      width: 1280,
      height: 800,
      minWidth: 640,
      minHeight: 480,
      title: loaded.manifest.name,
      icon: APP_ICON,
      backgroundColor: '#000000',
      webPreferences: sharedWebPreferences,
    })

    if (playerChrome.injectDragStrip) installDragStrip(win)

    sessionManager.register({
      window: win,
      server,
      rootDir: loaded.rootDir,
      manifest: loaded.manifest,
      ownsRootDir: loaded.ownsRootDir,
    })
    registered = true

    await win.loadURL(server.url)
    if (!win.isDestroyed()) win.show()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    // Unwind whatever we already allocated. If the session was
    // registered, destroying the window triggers its 'closed' handler
    // in SessionManager which closes the server and removes the temp
    // dir — we only need to force-destroy. Otherwise we clean up by
    // hand, in reverse order of allocation.
    // If the window is already destroyed, the user closed it mid-load
    // (e.g. Cmd+W during loadURL) — that's not an error to surface.
    const userClosedMidLoad = registered && (!win || win.isDestroyed())

    if (registered && win && !win.isDestroyed()) {
      win.destroy()
    } else if (!registered) {
      if (win && !win.isDestroyed()) win.destroy()
      if (server) await server.close().catch(() => {})
      if (loaded?.ownsRootDir) {
        await rm(loaded.rootDir, { recursive: true, force: true }).catch(() => {})
      }
    }

    if (userClosedMidLoad) return

    void dialog.showMessageBox({
      type: 'error',
      title: 'Failed to open deck',
      message: 'Failed to open deck',
      detail: `${message}\n\nPath: ${deckPath}`,
    })
  }
}
