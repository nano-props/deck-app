import { app, BaseWindow, shell, webContents, type WebContents } from 'electron'
import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { AppWindow } from '#/main/app-window/index.ts'
import { createNewDeckInWindow, promptOpenDeck, saveDeckAsInWindow } from '#/main/dialogs.ts'
import { recordOpen } from '#/main/recents.ts'
import { focusedAppWindow } from '#/main/window-registry.ts'
import { openSettingsWindow } from '#/main/settings-window/index.ts'
import type { MenuActionId } from '#/main/menu/types.ts'

export const ACTIONS: Record<MenuActionId, () => void | Promise<void>> = {
  'app.settings': () => openSettingsWindow('appearance'),
  'app.about': () => openSettingsWindow('about'),
  'file.newDeck': newDeckMenuAction,
  'file.newWindow': () => {
    new AppWindow()
  },
  'file.openFile': openFileMenuAction,
  'file.editDeck': editCurrentDeck,
  'file.playDeck': playCurrentDeck,
  'file.save': saveCurrentDeckMenuAction,
  'file.saveAs': saveCurrentDeckAsMenuAction,
  'file.reveal': revealCurrentDeckInFiles,
  'file.chats': openChatsFolderAction,
  'file.closeWindow': () => {
    // Cmd+W / Ctrl+W must close whichever window has focus — AppWindow
    // (deck) OR the Settings window. `focusedAppWindow()` only knows
    // about the AppWindow registry, so it returns undefined when the
    // Settings window is focused, leaving the user stuck. Walk every
    // live BaseWindow (which BrowserWindow inherits from) and close
    // the focused one.
    const focused = BaseWindow.getAllWindows().find((w) => !w.isDestroyed() && w.isFocused())
    focused?.close()
  },
  'file.closeDeck': closeCurrentDeck,
  'file.quit': () => app.quit(),
  // Edit actions. On the native menu path Electron drives these via
  // `role` (see electron-template.ts) so Chromium's own default handling
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
    focusedAppWindow()?.toggleFullScreen()
  },
  // DevTools is chrome-only: we'd rather users not attach DevTools to
  // deckView (untrusted deck HTML — no preload, nothing for us to
  // debug from the app side anyway).
  'view.toggleDevTools': () => {
    focusedChromeWc()?.toggleDevTools()
  },
}

export function focusedChromeWc(): WebContents | undefined {
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

async function openSomehow(picked: string): Promise<void> {
  const focused = focusedAppWindow()
  const target = focused && !focused.getDeck() ? focused : new AppWindow()
  if (target !== focused) target.focus()
  const ok = await target.openDeck(picked)
  const deck = target.getDeck()
  if (ok && deck) {
    recordOpen({ path: picked, name: deck.manifest.name }).catch((err) => {
      console.warn('[recents] recordOpen failed', err)
    })
  }
}

async function openFileMenuAction(): Promise<void> {
  const picked = await promptOpenDeck()
  if (picked) await openSomehow(picked)
}

async function newDeckMenuAction(): Promise<void> {
  const focused = focusedAppWindow()
  const target = focused && !focused.getDeck() ? focused : new AppWindow()
  if (target !== focused) target.focus()
  await createNewDeckInWindow(target)
}

/**
 * cmd/ctrl+E acts as a toggle: from Play mode it enters the Editor;
 * from Edit mode it returns to Play. A single shortcut flipping both
 * directions matches how users intuit the keybinding ("E for edit on /
 * edit off"). Cmd+Alt+P stays as the unambiguous "go to play" entry
 * from menus regardless of current mode.
 */
function editCurrentDeck(): void {
  const w = focusedAppWindow()
  if (!w?.getDeck()) return
  if (w.getSubView() === 'edit') w.enterPlayer()
  else w.enterEditor()
}

function playCurrentDeck(): void {
  const w = focusedAppWindow()
  if (w?.getDeck()) w.enterPlayer()
}

async function saveCurrentDeckMenuAction(): Promise<void> {
  const w = focusedAppWindow()
  if (!w || !w.getDeck()) return
  await w.saveDeck()
}

async function saveCurrentDeckAsMenuAction(): Promise<void> {
  const w = focusedAppWindow()
  if (!w || !w.getDeck()) return
  await saveDeckAsInWindow(w)
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
 * Reveal the deck in the OS file browser. For a Pack we point at the
 * `.deck` file the user opened (not the temp extraction — that's an
 * implementation detail). For a Source we point at the directory.
 */
function revealCurrentDeckInFiles(): void {
  const deck = focusedAppWindow()?.getDeck()
  if (!deck) return
  shell.showItemInFolder(deck.sourcePath)
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
