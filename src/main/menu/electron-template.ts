import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import { t } from '#/main/i18n/index.ts'
import { allAppWindows } from '#/main/window-registry.ts'
import { ACTIONS } from '#/main/menu/actions.ts'
import type { MenuNode } from '#/main/menu/types.ts'

const IS_MAC = process.platform === 'darwin'

export function nodeToElectron(node: MenuNode): MenuItemConstructorOptions {
  if (node.kind === 'separator') return { type: 'separator' }
  if (node.kind === 'submenu') {
    return {
      label: node.label,
      submenu: node.items.map(nodeToElectron),
    }
  }
  return {
    label: node.label,
    accelerator: node.accelerator,
    enabled: node.enabled,
    click: () => {
      void ACTIONS[node.id]()
    },
  }
}

export function applyNativeMenu(tree: MenuNode[]): void {
  // i18n trade-offs — we override OS-default labels everywhere so the
  // menu tracks Settings → Language instead of the OS locale. Costs:
  //
  //   1. Edit submenu uses per-item `role` rather than `role: 'editMenu'`.
  //      Per-item role still lets Chromium route ⌘Z/X/C/V/A to the
  //      actually-focused WebContents (chromeView inputs AND deckView)
  //      — a `click: () => wc.xxx()` closure can't do that, it only hits
  //      the chromeView. The self-drawn menu (Win/Linux) renders the
  //      same tree and dispatches through `ACTIONS['edit.*']` →
  //      `focusedTargetWc()` for the same reason.
  //      Cost: macOS loses the auto-injected "Start Dictation" and
  //      "Emoji & Symbols" items that `role: 'editMenu'` provides. The
  //      OS keyboard shortcuts (fn-fn / Ctrl+Cmd+Space) still work.
  //
  //   2. Window submenu is built explicitly rather than via
  //      `role: 'windowMenu'`. Cost: AppKit no longer auto-populates the
  //      list of open windows under "Bring All to Front" or auto-binds
  //      the menu to `[NSApp setWindowsMenu:]`. Acceptable here because
  //      this app's multi-window UX is bounded (one deck per window).
  const templateMiddle: MenuItemConstructorOptions[] = tree.map((node) =>
    node.kind === 'submenu' && node.id === 'edit' ? editMenuWithRoles(node) : nodeToElectron(node),
  )
  const template: MenuItemConstructorOptions[] = [
    ...(IS_MAC ? [macAppMenu()] : []),
    ...templateMiddle,
    ...(IS_MAC ? [macWindowMenu()] : []),
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * Build the native Edit submenu by mapping our flat tree onto Electron's
 * editing roles, while preserving the labels from `t()`. Role drives the
 * key handling (so accelerators reach deckView too); label overrides what
 * the OS would otherwise render in its own language.
 */
function editMenuWithRoles(node: MenuNode & { kind: 'submenu' }): MenuItemConstructorOptions {
  const ROLE_BY_ID: Record<string, MenuItemConstructorOptions['role']> = {
    'edit.undo': 'undo',
    'edit.redo': 'redo',
    'edit.cut': 'cut',
    'edit.copy': 'copy',
    'edit.paste': 'paste',
    'edit.selectAll': 'selectAll',
  }
  const submenu: MenuItemConstructorOptions[] = node.items.map((item) => {
    if (item.kind === 'separator') return { type: 'separator' }
    if (item.kind === 'submenu') return nodeToElectron(item)
    const role = ROLE_BY_ID[item.id]
    return role
      ? { role, label: item.label, accelerator: item.accelerator, enabled: item.enabled }
      : nodeToElectron(item)
  })
  return { label: node.label, submenu }
}

/**
 * Push the latest tree to every registered chrome WebContents. No-op on
 * macOS: the OS menu bar is the source of truth there, and the renderer
 * never subscribes (see AppMenu.tsx). Skipping the send avoids
 * serializing a tree nothing listens for on every `buildMenu()` call.
 */
export function pushMenuTreeToRenderers(tree: MenuNode[]): void {
  if (IS_MAC) return
  for (const w of allAppWindows()) {
    if (w.isDestroyed()) continue
    const wc = w.getChromeWebContents()
    if (wc.isDestroyed()) continue
    try {
      wc.send('app:menu-tree', tree)
    } catch {
      // Destroyed between the check and the send — teardown race.
    }
  }
}

function macAppMenu(): MenuItemConstructorOptions {
  // Every standard role item carries a `label` so the application menu
  // tracks the user's chosen Settings → Language, not the OS locale.
  // {name} in the dictionary entries is substituted with `app.name`.
  const name = app.name
  return {
    label: name,
    submenu: [
      // Custom About handler instead of `role: 'about'` — we route to our
      // own SettingsWindow About tab so all three platforms see the same
      // (themed, translated, version-rich) About surface. Both items go
      // through the ACTIONS table so the dispatch path is identical to
      // Win/Linux's self-drawn menu and to file menu activations.
      {
        label: t('menu.app.about', { name }),
        click: () => void ACTIONS['app.about'](),
      },
      { type: 'separator' },
      {
        label: t('menu.file.settings'),
        accelerator: 'Cmd+,',
        click: () => void ACTIONS['app.settings'](),
      },
      { type: 'separator' },
      { role: 'services', label: t('menu.app.services') },
      { type: 'separator' },
      { role: 'hide', label: t('menu.app.hide', { name }) },
      { role: 'hideOthers', label: t('menu.app.hideOthers') },
      { role: 'unhide', label: t('menu.app.showAll') },
      { type: 'separator' },
      { role: 'quit', label: t('menu.app.quit', { name }) },
    ],
  }
}

function macWindowMenu(): MenuItemConstructorOptions {
  // Mirrors Electron's `role: 'windowMenu'` shape but with explicit
  // labels so it follows the user's language. Roles still drive the
  // behavior — Minimize / Zoom / Close / Bring All to Front all hand
  // off to AppKit's standard window selectors.
  return {
    label: t('menu.window'),
    submenu: [
      { role: 'minimize', label: t('menu.window.minimize') },
      { role: 'zoom', label: t('menu.window.zoom') },
      { type: 'separator' },
      { role: 'close', label: t('menu.window.close') },
      { type: 'separator' },
      { role: 'front', label: t('menu.window.bringAllToFront') },
    ],
  }
}
