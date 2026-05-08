import { t } from '#/main/i18n/index.ts'
import { focusedAppWindow } from '#/main/window-registry.ts'
import type { MenuLeaf, MenuNode, MenuSeparator } from '#/main/menu/types.ts'

const IS_MAC = process.platform === 'darwin'

function hasDeckOpen(): boolean {
  return !!focusedAppWindow()?.getDeck()
}

/**
 * Save flushes the live extraction back into the original `.deck` file.
 * Only meaningful for Pack-kind decks; Source-kind decks already write
 * through to the user's directory, so the menu item disables there.
 */
function canSaveCurrentDeck(): boolean {
  const deck = focusedAppWindow()?.getDeck()
  return !!deck && deck.kind === 'pack'
}

/**
 * Reveal opens the rootDir in Finder/Explorer. For a Pack the rootDir
 * is a temp extraction — useful for debugging but not what the user
 * usually wants. We still show it for both kinds; the user-facing
 * thing they care about (the .deck file itself) is one level up and
 * easy to navigate to from the temp dir reveal.
 */
function canRevealCurrentDeck(): boolean {
  return hasDeckOpen()
}

/**
 * Build the current menu tree. `enabled` values snapshot the focused
 * window's state at call time; `buildMenu()` is re-invoked on focus
 * change and mode transitions (see AppWindow.broadcastState) so the
 * snapshot doesn't stay stale.
 *
 * Exported so the renderer's initial fetch (`app:menu-tree-get`) can
 * return a current snapshot synchronously rather than waiting on the
 * broadcast round-trip.
 */
export function buildMenuTree(): MenuNode[] {
  const fileItems: MenuNode[] = [
    { kind: 'leaf', id: 'file.newDeck', label: t('menu.file.newDeck'), accelerator: 'CmdOrCtrl+N', enabled: true },
    {
      kind: 'leaf',
      id: 'file.newWindow',
      label: t('menu.file.newWindow'),
      accelerator: 'CmdOrCtrl+Alt+N',
      enabled: true,
    },
    { kind: 'separator' },
    { kind: 'leaf', id: 'file.openFile', label: t('menu.file.openFile'), accelerator: 'CmdOrCtrl+O', enabled: true },
    {
      kind: 'leaf',
      id: 'file.openFolder',
      label: t('menu.file.openFolder'),
      accelerator: 'CmdOrCtrl+Shift+O',
      enabled: true,
    },
    { kind: 'separator' },
    {
      kind: 'leaf',
      id: 'file.editDeck',
      label: t('menu.file.editDeck'),
      accelerator: 'CmdOrCtrl+E',
      enabled: hasDeckOpen(),
    },
    {
      kind: 'leaf',
      id: 'file.playDeck',
      label: t('menu.file.playDeck'),
      accelerator: 'CmdOrCtrl+Alt+P',
      enabled: hasDeckOpen(),
    },
    { kind: 'separator' },
    {
      kind: 'leaf',
      id: 'file.save',
      label: t('menu.file.save'),
      accelerator: 'CmdOrCtrl+S',
      enabled: canSaveCurrentDeck(),
    },
    {
      kind: 'leaf',
      id: 'file.saveAs',
      label: t('menu.file.saveAs'),
      accelerator: 'CmdOrCtrl+Shift+S',
      enabled: hasDeckOpen(),
    },
    {
      kind: 'leaf',
      id: 'file.reveal',
      label: IS_MAC ? t('menu.file.revealMac') : t('menu.file.revealWin'),
      enabled: canRevealCurrentDeck(),
    },
    { kind: 'separator' },
    { kind: 'leaf', id: 'file.chats', label: t('menu.file.chats'), enabled: true },
    ...((IS_MAC
      ? []
      : [
          { kind: 'separator' } as MenuSeparator,
          {
            kind: 'leaf',
            id: 'app.settings',
            label: t('menu.file.settings'),
            accelerator: 'Ctrl+,',
            enabled: true,
          } as MenuLeaf,
        ]) as MenuNode[]),
    { kind: 'separator' },
    // On macOS ⌘W closes the window (platform convention). The deck
    // still teardowns via the window-closed handler, so no resources
    // leak; users who want to return to launcher use "Close Deck and
    // Return to Launcher" below.
    {
      kind: 'leaf',
      id: 'file.closeWindow',
      label: t('menu.file.closeWindow'),
      accelerator: 'CmdOrCtrl+W',
      enabled: true,
    },
    {
      kind: 'leaf',
      id: 'file.closeDeck',
      label: t('menu.file.closeDeck'),
      accelerator: 'CmdOrCtrl+Shift+W',
      enabled: hasDeckOpen(),
    },
    ...((IS_MAC
      ? []
      : [
          { kind: 'separator' } as MenuSeparator,
          {
            kind: 'leaf',
            id: 'file.quit',
            label: t('menu.file.quit'),
            accelerator: 'CmdOrCtrl+Q',
            enabled: true,
          } as MenuLeaf,
        ]) as MenuNode[]),
  ]

  // These display-only accelerators must match what Electron's
  // `editMenu` role actually binds — the native menu (role) owns the
  // key registration, our tree owns the label. Redo diverges per
  // platform: mac uses ⇧⌘Z, Win/Linux uses Ctrl+Y.
  const editItems: MenuNode[] = [
    { kind: 'leaf', id: 'edit.undo', label: t('menu.edit.undo'), accelerator: 'CmdOrCtrl+Z', enabled: true },
    {
      kind: 'leaf',
      id: 'edit.redo',
      label: t('menu.edit.redo'),
      accelerator: IS_MAC ? 'Shift+CmdOrCtrl+Z' : 'CmdOrCtrl+Y',
      enabled: true,
    },
    { kind: 'separator' },
    { kind: 'leaf', id: 'edit.cut', label: t('menu.edit.cut'), accelerator: 'CmdOrCtrl+X', enabled: true },
    { kind: 'leaf', id: 'edit.copy', label: t('menu.edit.copy'), accelerator: 'CmdOrCtrl+C', enabled: true },
    { kind: 'leaf', id: 'edit.paste', label: t('menu.edit.paste'), accelerator: 'CmdOrCtrl+V', enabled: true },
    { kind: 'leaf', id: 'edit.selectAll', label: t('menu.edit.selectAll'), accelerator: 'CmdOrCtrl+A', enabled: true },
  ]

  const viewItems: MenuNode[] = [
    {
      kind: 'leaf',
      id: 'view.reload',
      label: t('menu.view.reload'),
      accelerator: 'CmdOrCtrl+R',
      enabled: hasDeckOpen(),
    },
    {
      kind: 'leaf',
      id: 'view.forceReload',
      label: t('menu.view.forceReload'),
      accelerator: 'CmdOrCtrl+Shift+R',
      enabled: hasDeckOpen(),
    },
    { kind: 'separator' },
    { kind: 'leaf', id: 'view.resetZoom', label: t('menu.view.resetZoom'), accelerator: 'CmdOrCtrl+0', enabled: true },
    { kind: 'leaf', id: 'view.zoomIn', label: t('menu.view.zoomIn'), accelerator: 'CmdOrCtrl+Plus', enabled: true },
    { kind: 'leaf', id: 'view.zoomOut', label: t('menu.view.zoomOut'), accelerator: 'CmdOrCtrl+-', enabled: true },
    { kind: 'separator' },
    {
      kind: 'leaf',
      id: 'view.toggleFullScreen',
      label: t('menu.view.toggleFullScreen'),
      accelerator: IS_MAC ? 'Ctrl+Cmd+F' : 'F11',
      enabled: true,
    },
    { kind: 'separator' },
    {
      kind: 'leaf',
      id: 'view.toggleDevTools',
      label: t('menu.view.toggleDevTools'),
      accelerator: IS_MAC ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
      enabled: true,
    },
  ]

  return [
    { kind: 'submenu', id: 'file', label: t('menu.file'), items: fileItems },
    { kind: 'submenu', id: 'edit', label: t('menu.edit'), items: editItems },
    { kind: 'submenu', id: 'view', label: t('menu.view'), items: viewItems },
  ]
}
