import { app, nativeImage } from 'electron'
import { existsSync } from 'node:fs'
import { auditModelCatalog } from '#/main/ai/provider.ts'
import { APP_ICON, AppWindow, isDeckPath } from '#/main/app-window.ts'
import { allAppWindows, focusedAppWindow } from '#/main/window-registry.ts'
import { sweepStaleTempDirs } from '#/main/deck-loader.ts'
import { buildMenu } from '#/main/menu.ts'
import { wireAiIpc } from '#/main/ipc/ai.ts'
import { wireDeckLifecycleIpc } from '#/main/ipc/deck-lifecycle.ts'
import { wireLayoutIpc } from '#/main/ipc/layout.ts'
import { wireMenuIpc } from '#/main/ipc/menu.ts'
import { wireRecentsIpc } from '#/main/ipc/recents.ts'
import { wireSettingsIpc } from '#/main/ipc/settings.ts'
import { recordOpen } from '#/main/recents.ts'

/** Files queued up before the app was ready (macOS open-file, argv). */
const pendingOpens: string[] = []

function argvDeckPaths(argv: string[]): string[] {
  // argv layout:
  //   dev:      ['electron', '<app-path>', ...userArgs]     → skip 2
  //   packaged: ['<bundled-main>', ...userArgs]             → skip 1
  const userArgs = argv.slice(app.isPackaged ? 1 : 2)
  const out: string[] = []
  for (const a of userArgs) {
    if (!a || a === '.' || a.startsWith('-')) continue
    if (isDeckPath(a)) out.push(a)
  }
  return out
}

/**
 * Route "open a deck" to the right AppWindow:
 *   - If the deck is already open somewhere, focus that window.
 *   - Otherwise, reuse the focused AppWindow if it has no deck loaded
 *     (launcher mode). Fills the empty shell instead of spawning a second
 *     blank window — this is the "single-window" feel.
 *   - Otherwise, spawn a new AppWindow.
 */
async function openDeckSomewhere(deckPath: string): Promise<void> {
  const focused = focusedAppWindow()
  const target =
    focused && !focused.getDeck() ? focused : (allAppWindows().find((w) => !w.getDeck()) ?? new AppWindow())
  if (target !== focused) target.focus()
  const ok = await target.openDeck(deckPath)
  if (ok && target.getDeck()) {
    void recordOpen({ path: deckPath, name: target.getDeck()!.manifest.name })
  }
}

function wireAppEvents(): void {
  app.on('open-file', (event, filePath) => {
    event.preventDefault()
    if (app.isReady()) {
      void openDeckSomewhere(filePath)
    } else {
      pendingOpens.push(filePath)
    }
  })

  app.on('second-instance', (_event, argv) => {
    const paths = argvDeckPaths(argv)
    if (paths.length > 0) {
      for (const p of paths) void openDeckSomewhere(p)
    } else {
      // Focus an existing window, or spawn a fresh launcher if none exist.
      const existing = allAppWindows()[0]
      if (existing) existing.focus()
      else new AppWindow()
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    if (allAppWindows().length === 0) new AppWindow()
  })

  let isQuitting = false
  app.on('before-quit', async (event) => {
    if (isQuitting || allAppWindows().length === 0) return
    event.preventDefault()
    isQuitting = true
    try {
      // Let each window's `closed` handler clean up its deck/server/ai.
      await Promise.all(
        allAppWindows().map(
          (w) =>
            new Promise<void>((resolve) => {
              const bw = w.getBaseWindow()
              if (bw.isDestroyed()) return resolve()
              bw.once('closed', () => resolve())
              w.close()
            }),
        ),
      )
    } finally {
      app.exit(0)
    }
  })
}

async function main(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  wireAppEvents()

  await app.whenReady()

  // Dock icon in dev (packaged builds already carry the icon in the .app).
  if (process.platform === 'darwin' && !app.isPackaged) {
    if (existsSync(APP_ICON)) {
      app.dock?.setIcon(nativeImage.createFromPath(APP_ICON))
    } else {
      console.warn(`[deck] app icon not found at ${APP_ICON} — Dock will show default`)
    }
  }

  await sweepStaleTempDirs()
  auditModelCatalog()
  buildMenu()
  wireDeckLifecycleIpc()
  wireLayoutIpc()
  wireMenuIpc()
  wireRecentsIpc()
  wireAiIpc()
  wireSettingsIpc()

  const queued = [...pendingOpens, ...argvDeckPaths(process.argv)]
  if (queued.length > 0) {
    // Open each deck in its own window (first one may reuse the initial
    // launcher, subsequent ones spawn).
    for (const p of queued) await openDeckSomewhere(p)
  }

  // If nothing is open, show a launcher.
  if (allAppWindows().length === 0) {
    new AppWindow()
  }
}

void main()
