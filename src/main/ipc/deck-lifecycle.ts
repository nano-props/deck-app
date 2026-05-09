import { dialog, ipcMain } from 'electron'
import { AppWindow } from '#/main/app-window/index.ts'
import { isDeckPath } from '#/main/window-shell.ts'
import { appWindowByWebContents } from '#/main/window-registry.ts'
import { createNewDeckInWindow, promptOpenDeck, saveDeckAsInWindow } from '#/main/dialogs.ts'
import { t } from '#/main/i18n/index.ts'
import { chromeOnly } from '#/main/ipc/guard.ts'
import { recordOpen } from '#/main/recents.ts'

function logRecentsError(err: unknown): void {
  // recents.json is best-effort UX scaffolding — a failed write should
  // not crash the open-deck flow, but it MUST surface in the console so
  // a recurring disk error doesn't sit silent.
  console.warn('[recents] recordOpen failed', err)
}

/**
 * Deck-mode transitions and the window-shell channels that drive them.
 *
 * Channels:
 *   app:get-state / app:new-window      — window-level introspection + spawn
 *   app:open-dialog / app:open-path / app:new-deck
 *                                       — ways to populate the window with a deck
 *   app:close-deck / app:enter-editor / app:enter-player
 *                                       — sub-view transitions once a deck is loaded
 *   app:reload-preview                  — refetch the iframe without touching chat
 *   app:save-deck                       — flush a Pack's edits back to its .deck
 *   app:save-deck-as                    — copy current contents to a new .deck
 */
export function wireDeckLifecycleIpc(): void {
  ipcMain.handle(
    'app:get-state',
    chromeOnly((event) => {
      return appWindowByWebContents(event.sender)?.getState() ?? null
    }),
  )
  ipcMain.handle(
    'app:new-window',
    chromeOnly(() => {
      new AppWindow()
    }),
  )

  ipcMain.handle(
    'app:open-dialog',
    chromeOnly(async (event) => {
      const picked = await promptOpenDeck()
      if (!picked) return
      const w = appWindowByWebContents(event.sender)
      if (w) {
        const ok = await w.openDeck(picked)
        if (ok && w.getDeck()) {
          recordOpen({ path: picked, name: w.getDeck()!.manifest.name }).catch(logRecentsError)
        }
      }
    }),
  )
  ipcMain.handle(
    'app:open-path',
    chromeOnly(async (event, input: unknown) => {
      if (typeof input !== 'string' || !input) return
      if (!isDeckPath(input)) {
        void dialog.showMessageBox({
          type: 'error',
          title: t('dialog.cantOpen.title'),
          message: t('dialog.cantOpen.message'),
          detail: t('dialog.cantOpen.detail', { path: input }),
        })
        return
      }
      const w = appWindowByWebContents(event.sender)
      if (w) {
        const ok = await w.openDeck(input)
        if (ok && w.getDeck()) {
          recordOpen({ path: input, name: w.getDeck()!.manifest.name }).catch(logRecentsError)
        }
      }
    }),
  )
  ipcMain.handle(
    'app:new-deck',
    chromeOnly(async (event) => {
      const w = appWindowByWebContents(event.sender)
      if (w) await createNewDeckInWindow(w)
    }),
  )
  ipcMain.handle(
    'app:close-deck',
    chromeOnly(async (event) => {
      const w = appWindowByWebContents(event.sender)
      if (w) await w.closeDeck()
    }),
  )
  ipcMain.handle(
    'app:enter-editor',
    chromeOnly((event) => {
      const w = appWindowByWebContents(event.sender)
      if (!w || !w.getDeck()) return
      w.enterEditor()
    }),
  )
  ipcMain.handle(
    'app:enter-player',
    chromeOnly((event) => {
      const w = appWindowByWebContents(event.sender)
      w?.enterPlayer()
    }),
  )
  ipcMain.handle(
    'app:reload-preview',
    chromeOnly((event) => {
      const w = appWindowByWebContents(event.sender)
      w?.reloadDeck(false)
    }),
  )
  ipcMain.handle(
    'app:save-deck',
    chromeOnly(async (event) => {
      const w = appWindowByWebContents(event.sender)
      if (w) await w.saveDeck()
    }),
  )
  ipcMain.handle(
    'app:save-deck-as',
    chromeOnly(async (event) => {
      const w = appWindowByWebContents(event.sender)
      if (w) await saveDeckAsInWindow(w)
    }),
  )
}
