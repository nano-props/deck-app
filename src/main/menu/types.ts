/**
 * One id per leaf action. Native Electron `click` callbacks and the
 * self-drawn menu in the renderer (Win/Linux) both dispatch through the
 * same `ACTIONS` table, so there's a single source of truth for what
 * each item does.
 */
export type MenuActionId =
  | 'app.settings'
  | 'app.about'
  | 'file.newDeck'
  | 'file.newWindow'
  | 'file.openFile'
  | 'file.editDeck'
  | 'file.playDeck'
  | 'file.save'
  | 'file.saveAs'
  | 'file.reveal'
  | 'file.chats'
  | 'file.closeWindow'
  | 'file.closeDeck'
  | 'file.quit'
  | 'edit.undo'
  | 'edit.redo'
  | 'edit.cut'
  | 'edit.copy'
  | 'edit.paste'
  | 'edit.selectAll'
  | 'view.reload'
  | 'view.forceReload'
  | 'view.resetZoom'
  | 'view.zoomIn'
  | 'view.zoomOut'
  | 'view.toggleFullScreen'
  | 'view.toggleDevTools'

/**
 * Serializable menu-tree shape sent over IPC to the renderer. Only leaf
 * items carry an `id`; submenus nest `items`. Accelerators are kept as
 * the Electron-style string ("CmdOrCtrl+Shift+E") — the renderer maps
 * them to a display form (⇧⌘E on mac, Ctrl+Shift+E elsewhere).
 */
export interface MenuLeaf {
  kind: 'leaf'
  id: MenuActionId
  label: string
  accelerator?: string
  enabled: boolean
}

export interface MenuSeparator {
  kind: 'separator'
}

export interface MenuSubmenu {
  kind: 'submenu'
  /** Stable identifier — the label is localized, so `id` is what
   *  cross-language code (e.g. native-menu Edit role swap) keys on. */
  id: 'file' | 'edit' | 'view'
  label: string
  items: MenuNode[]
}

export type MenuNode = MenuLeaf | MenuSeparator | MenuSubmenu
