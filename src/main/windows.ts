import { app, BrowserWindow, dialog } from 'electron'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { loadDeck, DeckLoadError } from '#/main/deck-loader.ts'
import { resolveDragMode, type DeckManifest } from '#/main/deck-types.ts'
import { startDeckServer } from '#/main/server.ts'
import { sessionManager } from '#/main/session-manager.ts'
import { installDragRegions } from '#/main/player-drag.ts'

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

const IS_MAC = process.platform === 'darwin'

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
  // window.deckApp) and keeps traffic lights pinned.
  const win = new BrowserWindow({
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 12, y: 14 },
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

    // Player: no chrome, no traffic lights — author content fills the
    // window; drag is provided via CSS by installDragRegions below.
    // `show: false` avoids a blank-window flash if loadURL fails.
    win = new BrowserWindow({
      show: false,
      titleBarStyle: IS_MAC ? 'hidden' : 'default',
      width: 1280,
      height: 800,
      minWidth: 640,
      minHeight: 480,
      title: loaded.manifest.name,
      icon: APP_ICON,
      backgroundColor: '#000000',
      webPreferences: sharedWebPreferences,
    })

    if (IS_MAC) {
      win.setWindowButtonVisibility(false)
      installDragRegions(win, resolveDragMode(loaded.manifest.drag))
    }

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
