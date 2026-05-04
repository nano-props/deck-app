import { app, Menu, shell, webContents, type MenuItemConstructorOptions, type WebContents } from 'electron'
import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { AppWindow } from '#/main/app-window.ts'
import {
  createNewDeckInWindow,
  exportCurrentDeckAsPack,
  promptOpenDeck,
  promptOpenFolder,
  unpackAndOpenInEditor,
} from '#/main/dialogs.ts'
import { recordOpen } from '#/main/recents.ts'
import { allAppWindows, focusedAppWindow } from '#/main/window-registry.ts'
import { workspacesRoot } from '#/main/workspaces.ts'

const IS_MAC = process.platform === 'darwin'

const REVEAL_LABEL = IS_MAC ? 'Reveal Deck Source in Finder' : 'Show Deck Source in Explorer'

/**
 * One id per leaf action. Native Electron `click` callbacks and the
 * self-drawn menu in the renderer (Win/Linux) both dispatch through the
 * same `ACTIONS` table below, so there's a single source of truth for
 * what each item does.
 */
export type MenuActionId =
  | 'app.settings'
  | 'file.newDeck'
  | 'file.newWindow'
  | 'file.openFile'
  | 'file.openFolder'
  | 'file.editDeck'
  | 'file.playDeck'
  | 'file.export'
  | 'file.reveal'
  | 'file.workspaces'
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

const ACTIONS: Record<MenuActionId, () => void | Promise<void>> = {
  'app.settings': openSettingsOverlayAction,
  'file.newDeck': newDeckMenuAction,
  'file.newWindow': () => {
    new AppWindow()
  },
  'file.openFile': openFileMenuAction,
  'file.openFolder': openFolderMenuAction,
  'file.editDeck': editCurrentDeck,
  'file.playDeck': playCurrentDeck,
  'file.export': exportCurrentDeckMenuAction,
  'file.reveal': revealCurrentDeckInFiles,
  'file.workspaces': openWorkspacesFolderAction,
  'file.chats': openChatsFolderAction,
  'file.closeWindow': () => {
    focusedAppWindow()?.close()
  },
  'file.closeDeck': closeCurrentDeck,
  'file.quit': () => app.quit(),
  // Edit actions. On the native menu path Electron drives these via
  // `role` (see `buildMenu` below) so Chromium's own default handling
  // applies to whichever view has focus — including deckView. The
  // self-drawn menu has no equivalent, so for invoke() we resolve the
  // focused WebContents explicitly via `webContents.getFocusedWebContents()`
  // (covers both chromeView and deckView) and fall back to the focused
  // window's chromeView when nothing else has focus.
  'edit.undo': () => focusedTargetWc()?.undo(),
  'edit.redo': () => focusedTargetWc()?.redo(),
  'edit.cut': () => focusedTargetWc()?.cut(),
  'edit.copy': () => focusedTargetWc()?.copy(),
  'edit.paste': () => focusedTargetWc()?.paste(),
  'edit.selectAll': () => focusedTargetWc()?.selectAll(),
  'view.reload': () => performReload(false),
  'view.forceReload': () => performReload(true),
  // Zoom targets whichever WebContents has focus — matches the native
  // `zoomIn` / `zoomOut` / `resetZoom` roles. Users in Play may want to
  // zoom the deck; users in Edit may want to zoom the chat pane.
  'view.resetZoom': () => setFocusedZoomLevel(0),
  'view.zoomIn': () => adjustFocusedZoomLevel(+0.5),
  'view.zoomOut': () => adjustFocusedZoomLevel(-0.5),
  'view.toggleFullScreen': () => {
    const bw = focusedAppWindow()?.getBaseWindow()
    if (bw) bw.setFullScreen(!bw.isFullScreen())
  },
  // DevTools is chrome-only: we'd rather users not attach DevTools to
  // deckView (untrusted deck HTML — no preload, nothing for us to
  // debug from the app side anyway).
  'view.toggleDevTools': () => {
    focusedChromeWc()?.toggleDevTools()
  },
}

function focusedChromeWc(): WebContents | undefined {
  return focusedAppWindow()?.getChromeWebContents()
}

/**
 * The WebContents that Edit / Zoom actions should target. Prefers
 * Electron's focused WebContents (so Edit lands in deckView / chromeView
 * inputs / text areas correctly, and Zoom follows the user's attention)
 * and falls back to the focused window's chromeView when nothing has
 * focus — e.g. when invoke() arrives from the self-drawn menu whose
 * panel button was the last focused element.
 */
function focusedTargetWc(): WebContents | undefined {
  return webContents.getFocusedWebContents() ?? focusedChromeWc()
}

function setFocusedZoomLevel(level: number): void {
  const wc = focusedTargetWc()
  if (wc) wc.setZoomLevel(level)
}

function adjustFocusedZoomLevel(delta: number): void {
  const wc = focusedTargetWc()
  if (!wc) return
  wc.setZoomLevel(wc.getZoomLevel() + delta)
}

/** Invoked from the renderer-side custom menu. Unknown ids silently no-op. */
export async function invokeMenuAction(id: string): Promise<void> {
  const fn = ACTIONS[id as MenuActionId]
  if (!fn) return
  await fn()
}

// ---- Declarative menu tree ------------------------------------------------

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
  label: string
  items: MenuNode[]
}
export type MenuNode = MenuLeaf | MenuSeparator | MenuSubmenu

function hasDeckOpen(): boolean {
  return !!focusedAppWindow()?.getDeck()
}

/**
 * Export requires an unpacked Deck Source to pack. Called on every menu
 * rebuild so the File → Export item disables out when inapplicable.
 */
function canExportCurrentDeck(): boolean {
  const w = focusedAppWindow()
  const deck = w?.getDeck()
  return !!deck && deck.kind !== 'pack'
}

function canRevealCurrentDeck(): boolean {
  const deck = focusedAppWindow()?.getDeck()
  return !!deck && deck.kind !== 'pack'
}

/**
 * Build the current menu tree. `enabled` values snapshot the focused
 * window's state at call time; `buildMenu()` is re-invoked on focus
 * change and mode transitions (see app-window.ts::broadcastState) so
 * the snapshot doesn't stay stale.
 *
 * Exported so the renderer's initial fetch (`app:menu-tree-get`) can
 * return a current snapshot synchronously rather than waiting on the
 * broadcast round-trip.
 */
export function buildMenuTree(): MenuNode[] {
  const fileItems: MenuNode[] = [
    { kind: 'leaf', id: 'file.newDeck', label: 'New Deck…', accelerator: 'CmdOrCtrl+N', enabled: true },
    {
      kind: 'leaf',
      id: 'file.newWindow',
      label: 'New Window',
      accelerator: 'CmdOrCtrl+Alt+N',
      enabled: true,
    },
    { kind: 'separator' },
    { kind: 'leaf', id: 'file.openFile', label: 'Open .deck…', accelerator: 'CmdOrCtrl+O', enabled: true },
    {
      kind: 'leaf',
      id: 'file.openFolder',
      label: 'Open Folder…',
      accelerator: 'CmdOrCtrl+Shift+O',
      enabled: true,
    },
    { kind: 'separator' },
    {
      kind: 'leaf',
      id: 'file.editDeck',
      label: 'Edit Deck',
      accelerator: 'CmdOrCtrl+E',
      enabled: hasDeckOpen(),
    },
    {
      kind: 'leaf',
      id: 'file.playDeck',
      label: 'Play Deck',
      accelerator: 'CmdOrCtrl+Alt+P',
      enabled: hasDeckOpen(),
    },
    { kind: 'separator' },
    {
      kind: 'leaf',
      id: 'file.export',
      label: 'Export as .deck…',
      accelerator: 'CmdOrCtrl+Shift+E',
      enabled: canExportCurrentDeck(),
    },
    { kind: 'leaf', id: 'file.reveal', label: REVEAL_LABEL, enabled: canRevealCurrentDeck() },
    { kind: 'separator' },
    { kind: 'leaf', id: 'file.workspaces', label: 'Open Workspaces Folder', enabled: true },
    { kind: 'leaf', id: 'file.chats', label: 'Open Chats Folder', enabled: true },
    ...((IS_MAC
      ? []
      : [
          { kind: 'separator' } as MenuSeparator,
          {
            kind: 'leaf',
            id: 'app.settings',
            label: 'Settings…',
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
      label: 'Close Window',
      accelerator: 'CmdOrCtrl+W',
      enabled: true,
    },
    {
      kind: 'leaf',
      id: 'file.closeDeck',
      label: 'Close Deck and Return to Launcher',
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
            label: 'Quit',
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
    { kind: 'leaf', id: 'edit.undo', label: 'Undo', accelerator: 'CmdOrCtrl+Z', enabled: true },
    {
      kind: 'leaf',
      id: 'edit.redo',
      label: 'Redo',
      accelerator: IS_MAC ? 'Shift+CmdOrCtrl+Z' : 'CmdOrCtrl+Y',
      enabled: true,
    },
    { kind: 'separator' },
    { kind: 'leaf', id: 'edit.cut', label: 'Cut', accelerator: 'CmdOrCtrl+X', enabled: true },
    { kind: 'leaf', id: 'edit.copy', label: 'Copy', accelerator: 'CmdOrCtrl+C', enabled: true },
    { kind: 'leaf', id: 'edit.paste', label: 'Paste', accelerator: 'CmdOrCtrl+V', enabled: true },
    { kind: 'leaf', id: 'edit.selectAll', label: 'Select All', accelerator: 'CmdOrCtrl+A', enabled: true },
  ]

  const viewItems: MenuNode[] = [
    {
      kind: 'leaf',
      id: 'view.reload',
      label: 'Reload Preview',
      accelerator: 'CmdOrCtrl+R',
      enabled: hasDeckOpen(),
    },
    {
      kind: 'leaf',
      id: 'view.forceReload',
      label: 'Force Reload Preview',
      accelerator: 'CmdOrCtrl+Shift+R',
      enabled: hasDeckOpen(),
    },
    { kind: 'separator' },
    { kind: 'leaf', id: 'view.resetZoom', label: 'Actual Size', accelerator: 'CmdOrCtrl+0', enabled: true },
    { kind: 'leaf', id: 'view.zoomIn', label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', enabled: true },
    { kind: 'leaf', id: 'view.zoomOut', label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', enabled: true },
    { kind: 'separator' },
    {
      kind: 'leaf',
      id: 'view.toggleFullScreen',
      label: 'Toggle Full Screen',
      accelerator: IS_MAC ? 'Ctrl+Cmd+F' : 'F11',
      enabled: true,
    },
    { kind: 'separator' },
    {
      kind: 'leaf',
      id: 'view.toggleDevTools',
      label: 'Toggle Developer Tools',
      accelerator: IS_MAC ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
      enabled: true,
    },
  ]

  return [
    { kind: 'submenu', label: 'File', items: fileItems },
    { kind: 'submenu', label: 'Edit', items: editItems },
    { kind: 'submenu', label: 'View', items: viewItems },
  ]
}

// ---- Native Electron menu (accelerator registration) ----------------------

function nodeToElectron(node: MenuNode): MenuItemConstructorOptions {
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

export function buildMenu(): void {
  const tree = buildMenuTree()
  // Native-menu Edit always uses Electron's built-in `editMenu` role.
  // Reasons (apply on every platform):
  //   - macOS: carries the "Start Dictation" / "Emoji & Symbols" system
  //     items users expect in the OS menu bar.
  //   - Win/Linux: the native menu is hidden but still registers
  //     accelerators. Role-driven Undo/Cut/Copy/Paste/SelectAll let
  //     Chromium route the keystroke to the actually-focused WebContents
  //     (chromeView inputs AND deckView), which a `click: () => wc.xxx()`
  //     closure can't do — it would only hit the chromeView.
  // The self-drawn menu (Win/Linux) still renders our flat Edit tree and
  // dispatches through `ACTIONS['edit.*']` → `focusedTargetWc()`, which
  // prefers `webContents.getFocusedWebContents()` for the same reason.
  const templateMiddle: MenuItemConstructorOptions[] = tree.map((node) =>
    node.kind === 'submenu' && node.label === 'Edit'
      ? ({ role: 'editMenu' } as MenuItemConstructorOptions)
      : nodeToElectron(node),
  )
  const template: MenuItemConstructorOptions[] = [
    ...(IS_MAC ? [macAppMenu()] : []),
    ...templateMiddle,
    ...(IS_MAC ? [{ role: 'windowMenu' as const }] : []),
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  // On Win/Linux the native menu is invisible (setMenuBarVisibility(false)
  // in app-window.ts); the native Menu stays installed so accelerators
  // remain globally bound. Pushing the tree lets the self-drawn DOM menu
  // rebuild with fresh enabled-state snapshots.
  pushMenuTreeToRenderers(tree)
}

// ---- Renderer broadcast ----------------------------------------------------

/**
 * Push the latest tree to every registered chrome WebContents. No-op on
 * macOS: the OS menu bar is the source of truth there, and the renderer
 * never subscribes (see `ui/menu.js`). Skipping the send avoids
 * serializing a tree nothing listens for on every `buildMenu()` call.
 */
function pushMenuTreeToRenderers(tree: MenuNode[]): void {
  if (IS_MAC) return
  for (const w of allAppWindows()) {
    if (w.isDestroyed()) continue
    const wc = w.getChromeWebContents()
    if (wc.isDestroyed()) continue
    wc.send('app:menu-tree', tree)
  }
}

// ---- macOS app menu (unchanged shape) --------------------------------------

function macAppMenu(): MenuItemConstructorOptions {
  return {
    label: app.name,
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      {
        label: 'Settings…',
        accelerator: 'Cmd+,',
        click: () => void openSettingsOverlayAction(),
      },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  }
}

// ---- Action implementations ------------------------------------------------

function openSettingsOverlayAction(): void {
  const w = focusedAppWindow()
  w?.getChromeWebContents().send('app:open-settings-overlay')
}

async function openSomehow(picked: string): Promise<void> {
  const focused = focusedAppWindow()
  const target = focused && !focused.getDeck() ? focused : new AppWindow()
  if (target !== focused) target.focus()
  const ok = await target.openDeck(picked)
  if (ok && target.getDeck()) {
    void recordOpen({ path: picked, name: target.getDeck()!.manifest.name })
  }
}

async function openFileMenuAction(): Promise<void> {
  const picked = await promptOpenDeck()
  if (picked) await openSomehow(picked)
}

async function openFolderMenuAction(): Promise<void> {
  const picked = await promptOpenFolder()
  if (picked) await openSomehow(picked)
}

async function newDeckMenuAction(): Promise<void> {
  const focused = focusedAppWindow()
  const target = focused && !focused.getDeck() ? focused : new AppWindow()
  if (target !== focused) target.focus()
  await createNewDeckInWindow(target)
}

async function editCurrentDeck(): Promise<void> {
  const w = focusedAppWindow()
  if (!w) return
  const deck = w.getDeck()
  if (!deck) return
  if (deck.kind === 'pack') {
    // Deck Pack in memory — unpack into a workspace + open it here.
    const zip = deck.sourcePath
    const name = deck.manifest.name
    await w.closeDeck()
    await unpackAndOpenInEditor(zip, w, name)
    return
  }
  await w.enterEditor()
}

async function playCurrentDeck(): Promise<void> {
  const w = focusedAppWindow()
  if (w?.getDeck()) await w.enterPlayer()
}

async function exportCurrentDeckMenuAction(): Promise<void> {
  const w = focusedAppWindow()
  if (!w || !w.getDeck()) return
  await exportCurrentDeckAsPack(w)
}

/**
 * Reveal the chats directory in the OS file browser. `mkdir -p` first so
 * first-run (no chats written yet) still opens something — otherwise
 * `shell.openPath` on a missing path silently fails on some platforms.
 */
async function openChatsFolderAction(): Promise<void> {
  const dir = path.join(app.getPath('userData'), 'chats')
  await mkdir(dir, { recursive: true }).catch(() => {})
  await shell.openPath(dir)
}

/**
 * Reveal the current deck's rootDir. Works for any editable kind
 * (Source / Workspace); for a Pack the rootDir is a throwaway temp
 * extraction, so the menu item is disabled — the user wouldn't get a
 * useful location.
 */
function revealCurrentDeckInFiles(): void {
  const deck = focusedAppWindow()?.getDeck()
  if (!deck) return
  shell.showItemInFolder(deck.rootDir)
}

/** Open the workspaces root in the OS file browser. Create it first so
 *  a first-time user who hasn't edited any Pack yet still sees a folder. */
async function openWorkspacesFolderAction(): Promise<void> {
  const dir = workspacesRoot()
  await mkdir(dir, { recursive: true }).catch(() => {})
  await shell.openPath(dir)
}

async function closeCurrentDeck(): Promise<void> {
  const w = focusedAppWindow()
  if (w?.getDeck()) await w.closeDeck()
}

function performReload(ignoreCache: boolean): void {
  const w = focusedAppWindow()
  // Only reload the deck preview — never the app chrome (would blow away
  // chat transcript / in-flight AI stream).
  w?.reloadDeck(ignoreCache)
}
