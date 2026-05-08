import { ACTIONS } from '#/main/menu/actions.ts'
import { applyNativeMenu, pushMenuTreeToRenderers } from '#/main/menu/electron-template.ts'
import { buildMenuTree } from '#/main/menu/tree.ts'
import type { MenuActionId, MenuNode } from '#/main/menu/types.ts'

export type { MenuActionId, MenuLeaf, MenuNode, MenuSeparator, MenuSubmenu } from '#/main/menu/types.ts'
export { buildMenuTree } from '#/main/menu/tree.ts'

/**
 * Look up the enabled flag for `id` in the current menu tree. The
 * predicates in tree.ts (hasDeckOpen, canExportCurrentDeck, etc.) are
 * the single source of truth — re-walking the tree keeps invoke
 * behavior aligned with what the user actually sees.
 *
 * Returns `true` for ids that have no leaf in the tree (i.e. nothing
 * gates them) — `invokeMenuAction` then runs them unconditionally.
 */
function isMenuActionEnabled(id: MenuActionId): boolean {
  const tree = buildMenuTree()
  function walk(nodes: MenuNode[]): boolean | undefined {
    for (const n of nodes) {
      if (n.kind === 'leaf' && n.id === id) return n.enabled
      if (n.kind === 'submenu') {
        const found = walk(n.items)
        if (found !== undefined) return found
      }
    }
    return undefined
  }
  return walk(tree) ?? true
}

/**
 * Invoked from the renderer-side custom menu. Unknown ids silently
 * no-op. Disabled actions also no-op — defence-in-depth in case a
 * stale-tree race lets the renderer dispatch an item it shouldn't.
 */
export async function invokeMenuAction(id: string): Promise<void> {
  const fn = ACTIONS[id as MenuActionId]
  if (!fn) return
  if (!isMenuActionEnabled(id as MenuActionId)) return
  await fn()
}

export function buildMenu(): void {
  const tree = buildMenuTree()
  applyNativeMenu(tree)
  // On Win/Linux the native menu is invisible (setMenuBarVisibility(false)
  // in the AppWindow constructor); the native Menu stays installed so
  // accelerators remain globally bound. Pushing the tree lets the
  // self-drawn DOM menu rebuild with fresh enabled-state snapshots.
  pushMenuTreeToRenderers(tree)
}
