import { ipcMain } from 'electron'
import { chromeOnly } from '#/main/ipc/guard.ts'
import { buildMenuTree, invokeMenuAction, type MenuNode } from '#/main/menu.ts'

/**
 * Menu channels for the self-drawn DOM menu in the topbar (Win/Linux).
 * macOS uses the native OS menu bar and simply doesn't listen.
 *
 *   app:menu-tree (push)   — main → renderer. Sent on every buildMenu(),
 *                            i.e. after focus shifts or mode transitions
 *                            change any `enabled` values.
 *   app:menu-tree-get      — renderer → main. Initial fetch on boot. We
 *                            rebuild the tree on demand so the snapshot
 *                            reflects the currently focused window.
 *   app:menu-invoke(id)    — renderer → main. Run the action keyed by id.
 */
export function wireMenuIpc(): void {
  ipcMain.handle(
    'app:menu-tree-get',
    chromeOnly((): MenuNode[] => buildMenuTree()),
  )
  ipcMain.handle(
    'app:menu-invoke',
    chromeOnly(async (_event, id: unknown) => {
      if (typeof id !== 'string') return
      await invokeMenuAction(id)
    }),
  )
}
