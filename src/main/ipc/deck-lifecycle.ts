import { dialog, ipcMain } from 'electron'
import { AppWindow, isDeckPath } from '#/main/app-window.ts'
import { appWindowByWebContents } from '#/main/window-registry.ts'
import {
  createNewDeckInWindow,
  exportCurrentDeckAsPack,
  promptOpenDeck,
  promptOpenFolder,
  unpackAndOpenInEditor,
} from '#/main/dialogs.ts'
import { chromeOnly } from '#/main/ipc/guard.ts'
import { recordOpen } from '#/main/recents.ts'

/**
 * Deck-mode transitions and the window-shell channels that drive them.
 *
 * Channels:
 *   app:get-state / app:new-window      — window-level introspection + spawn
 *   app:open-dialog / app:open-folder / app:open-path / app:new-deck
 *                                       — ways to populate the window with a deck
 *   app:close-deck / app:enter-editor / app:enter-player
 *                                       — sub-view transitions once a deck is loaded
 *   app:reload-preview                  — refetch the iframe without touching chat
 *   app:export-deck                     — zip the current Deck Source into a .deck
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
          void recordOpen({ path: picked, name: w.getDeck()!.manifest.name })
        }
      }
    }),
  )
  ipcMain.handle(
    'app:open-folder',
    chromeOnly(async (event) => {
      const picked = await promptOpenFolder()
      if (!picked) return
      const w = appWindowByWebContents(event.sender)
      if (w) {
        const ok = await w.openDeck(picked)
        if (ok && w.getDeck()) {
          void recordOpen({ path: picked, name: w.getDeck()!.manifest.name })
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
          title: "Can't open that",
          message: "That doesn't look like a Deck",
          detail: `Drop a .deck file, or a folder containing deck.json.\n\nPath: ${input}`,
        })
        return
      }
      const w = appWindowByWebContents(event.sender)
      if (w) {
        const ok = await w.openDeck(input)
        if (ok && w.getDeck()) {
          void recordOpen({ path: input, name: w.getDeck()!.manifest.name })
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
    chromeOnly(async (event) => {
      const w = appWindowByWebContents(event.sender)
      if (!w || !w.getDeck()) return
      const deck = w.getDeck()
      if (deck?.kind === 'pack') {
        const zip = deck.sourcePath
        const name = deck.manifest.name
        await w.closeDeck()
        await unpackAndOpenInEditor(zip, w, name)
        return
      }
      await w.enterEditor()
    }),
  )
  ipcMain.handle(
    'app:enter-player',
    chromeOnly(async (event) => {
      const w = appWindowByWebContents(event.sender)
      if (w) await w.enterPlayer()
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
    'app:export-deck',
    chromeOnly(async (event) => {
      const w = appWindowByWebContents(event.sender)
      if (w) await exportCurrentDeckAsPack(w)
    }),
  )
}
