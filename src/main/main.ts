import { app, BrowserWindow, ipcMain, nativeImage } from 'electron'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { sweepStaleTempDirs } from '#/main/deck-loader.ts'
import { sessionManager } from '#/main/session-manager.ts'
import { APP_ICON, showLauncherWindow, openDeckInNewWindow } from '#/main/windows.ts'
import { buildMenu } from '#/main/menu.ts'
import { promptOpenDeck, promptOpenFolder } from '#/main/dialogs.ts'

/** Files queued up before the app was ready (macOS open-file, argv). */
const pendingOpens: string[] = []

/**
 * Collect deck paths from argv.
 *
 * argv layout differs between dev and packaged:
 *   - dev:      ['electron', '<app-path>', ...userArgs]     → skip 2
 *   - packaged: ['<bundled-main>', ...userArgs]             → skip 1
 *
 * We accept either a `.deck` file or a directory with `deck.json`. Flags,
 * the literal "." (common in `electron .`), and anything that's not a real
 * path are ignored.
 */
function argvDeckPaths(argv: string[]): string[] {
  const sliceAt = app.isPackaged ? 1 : 2
  const userArgs = argv.slice(sliceAt)
  const out: string[] = []
  for (const a of userArgs) {
    if (!a || a === '.' || a.startsWith('-')) continue
    try {
      const resolved = path.resolve(a)
      const s = statSync(resolved)
      if (s.isFile() && resolved.toLowerCase().endsWith('.deck')) out.push(resolved)
      else if (s.isDirectory() && existsSync(path.join(resolved, 'deck.json'))) out.push(resolved)
    } catch {
      // not a real path; skip
    }
  }
  return out
}

function wireAppEvents(): void {
  // macOS: double-clicking a .deck fires this event.
  app.on('open-file', (event, filePath) => {
    event.preventDefault()
    if (app.isReady()) {
      void openDeckInNewWindow(filePath)
    } else {
      pendingOpens.push(filePath)
    }
  })

  // Windows/Linux: a second launch (e.g. user double-clicks another .deck
  // while this app is running) fires 'second-instance' in the primary
  // process with the new argv. We route it through the same open path.
  app.on('second-instance', (_event, argv) => {
    const paths = argvDeckPaths(argv)
    for (const p of paths) void openDeckInNewWindow(p)
    // No deck in argv → bring up the Launcher. showLauncherWindow is
    // idempotent (focuses the existing Launcher rather than opening a
    // new one). Deliberately not just focusing `getAllWindows()[0]`
    // because its order isn't guaranteed — we could end up surfacing a
    // random Player instead of the app's starting point.
    if (paths.length === 0) showLauncherWindow()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) showLauncherWindow()
  })

  let isQuitting = false
  app.on('before-quit', async (event) => {
    if (isQuitting || sessionManager.size === 0) return
    event.preventDefault()
    isQuitting = true
    try {
      await sessionManager.disposeAll()
    } finally {
      app.exit(0)
    }
  })
}

function wireIpc(): void {
  ipcMain.handle('deck:open-dialog', async () => {
    await promptOpenDeck()
  })
  ipcMain.handle('deck:open-folder', async () => {
    await promptOpenFolder()
  })
}

async function main(): Promise<void> {
  // Ensure only one Deck App instance exists. A second launch — e.g.
  // double-clicking another .deck on Windows/Linux — receives a
  // 'second-instance' event in the primary and exits here.
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  wireAppEvents()

  await app.whenReady()

  // Show our icon in the Dock during development. In a packaged build
  // electron-builder bakes the icon into the .app bundle so this is a
  // no-op, but in `electron .` runs the Dock would otherwise show the
  // default Electron icon.
  //
  // nativeImage.createFromPath returns an *empty* image when the path
  // doesn't exist, which would silently blank out the Dock icon. We
  // check first and warn loudly so a packaging regression is visible.
  if (process.platform === 'darwin' && !app.isPackaged) {
    if (existsSync(APP_ICON)) {
      app.dock?.setIcon(nativeImage.createFromPath(APP_ICON))
    } else {
      console.warn(`[deck] app icon not found at ${APP_ICON} — Dock will show default`)
    }
  }

  await sweepStaleTempDirs()

  buildMenu()
  wireIpc()

  const fromArgv = argvDeckPaths(process.argv)
  const toOpen = [...pendingOpens, ...fromArgv]

  // Opens are independent (each spins its own server + window), so run
  // them in parallel. A failure in one doesn't block the others —
  // openDeckInNewWindow handles its own error dialog.
  await Promise.all(toOpen.map((p) => openDeckInNewWindow(p)))

  // If every queued open failed (or there were none), show the launcher
  // so the user has somewhere to go.
  if (BrowserWindow.getAllWindows().length === 0) {
    showLauncherWindow()
  }
}

void main()
