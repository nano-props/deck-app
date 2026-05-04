import { ipcMain } from 'electron'
import { chromeOnly } from '#/main/ipc/guard.ts'
import { forgetRecent, listRecents } from '#/main/recents.ts'

/**
 * Recents list exposed to the launcher. Thin IPC shims around recents.ts
 * — no window state involved.
 */
export function wireRecentsIpc(): void {
  ipcMain.handle(
    'app:list-recents',
    chromeOnly(async () => listRecents()),
  )
  ipcMain.handle(
    'app:forget-recent',
    chromeOnly(async (_event, p: unknown) => {
      if (typeof p === 'string') await forgetRecent(p)
    }),
  )
}
