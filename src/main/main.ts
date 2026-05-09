import { app, nativeImage } from 'electron'
import { existsSync } from 'node:fs'
import { auditModelCatalog } from '#/main/ai/provider.ts'
import { AppWindow } from '#/main/app-window/index.ts'
import { APP_ICON, isDeckPath } from '#/main/window-shell.ts'
import { allAppWindows, focusedAppWindow } from '#/main/window-registry.ts'
import { sweepStaleTempDirs } from '#/main/deck-loader.ts'
import { configureDeckSession } from '#/main/deck-view.ts'
import { assertDictionaryParity, resolveLang, setCurrentLang } from '#/main/i18n/index.ts'
import { buildMenu } from '#/main/menu/index.ts'
import { wireAiIpc } from '#/main/ipc/ai.ts'
import { wireDeckLifecycleIpc } from '#/main/ipc/deck-lifecycle.ts'
import { wireI18nIpc } from '#/main/ipc/i18n.ts'
import { wireLayoutIpc } from '#/main/ipc/layout.ts'
import { wireMenuIpc } from '#/main/ipc/menu.ts'
import { wireRecentsIpc } from '#/main/ipc/recents.ts'
import { wireSettingsIpc } from '#/main/ipc/settings.ts'
import { recordOpen } from '#/main/recents.ts'
import { getSettings } from '#/main/settings.ts'

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
  const deck = target.getDeck()
  if (ok && deck) {
    recordOpen({ path: deckPath, name: deck.manifest.name }).catch((err) => {
      console.warn('[recents] recordOpen failed', err)
    })
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
  // Hard cap on how long we'll wait for windows to close cleanly.
  // Without this, a single hung close (e.g. a stuck server or AI session
  // teardown) holds the whole process open forever — quitting becomes
  // a Force Quit problem. 3s is generous enough for a normal shutdown
  // (typically <100ms) and short enough that users don't notice the
  // ceiling when something does go wrong.
  const QUIT_TIMEOUT_MS = 3000
  app.on('before-quit', async (event) => {
    if (isQuitting || allAppWindows().length === 0) return
    event.preventDefault()
    isQuitting = true
    const closeAll = Promise.all(
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
    const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), QUIT_TIMEOUT_MS))
    try {
      const winner = await Promise.race([closeAll.then(() => 'closed' as const), timeout])
      if (winner === 'timeout') {
        console.warn(`[deck] window close exceeded ${QUIT_TIMEOUT_MS}ms; forcing exit`)
      }
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
  configureDeckSession()
  auditModelCatalog()
  assertDictionaryParity(!app.isPackaged)
  // Resolve language BEFORE buildMenu — every menu label runs through `t()`
  // and would otherwise render in the default ('en') for the first frame.
  const settings = await getSettings()
  setCurrentLang(resolveLang(settings.ui.lang))
  buildMenu()
  wireDeckLifecycleIpc()
  wireI18nIpc()
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
