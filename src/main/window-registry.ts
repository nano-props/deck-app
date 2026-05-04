import path from 'node:path'
import type { WebContents } from 'electron'
import type { AppWindow } from '#/main/app-window.ts'

/**
 * Global registry of live `AppWindow` instances. Kept outside `app-window.ts`
 * so the class definition isn't cluttered with map bookkeeping, and so that
 * IPC handlers / menu actions have a single, side-effect-free place to look
 * windows up.
 *
 * Dual-keyed:
 *   - by BaseWindow id         — for menu / shortcut dispatch
 *   - by chrome WebContents id — for IPC dispatch (`event.sender.id` is
 *                                the chrome view's `WebContents.id`)
 *
 * We also provide a `findByRootDir` lookup so `openDeck` can enforce the
 * mutual-exclusion invariant (one window per deck at a time).
 *
 * The `AppWindow` reference is a *type-only* import — it's erased at
 * runtime and the module graph stays acyclic at the value level.
 */

const byWindowId = new Map<number, AppWindow>()
const byChromeWcId = new Map<number, AppWindow>()

/** Called from `AppWindow` constructor. Both ids must be present. */
export function registerAppWindow(win: AppWindow, params: { windowId: number; chromeWcId: number }): void {
  byWindowId.set(params.windowId, win)
  byChromeWcId.set(params.chromeWcId, win)
}

/** Called from `AppWindow.handleClosed`. Safe to call twice. */
export function unregisterAppWindow(params: { windowId: number; chromeWcId: number }): void {
  byWindowId.delete(params.windowId)
  byChromeWcId.delete(params.chromeWcId)
}

export function appWindowByWindowId(id: number): AppWindow | undefined {
  return byWindowId.get(id)
}

export function appWindowByWebContents(wc: WebContents): AppWindow | undefined {
  return byChromeWcId.get(wc.id)
}

/**
 * True if `wc` is one of our registered chrome WebContents. Used as the
 * `validateSender` check on every `ipcMain.handle` — only the app chrome
 * (loaded from app.html with our preload) is allowed to invoke handlers.
 * Deck content runs in a separate WebContentsView without a preload, so
 * it can't reach `ipcRenderer`, but this guard makes that property
 * structural rather than configurational (Electron security checklist #17).
 */
export function isChromeWebContents(wc: WebContents): boolean {
  return byChromeWcId.has(wc.id)
}

/**
 * Canonicalize for identity comparison. macOS/Windows are case-insensitive;
 * Linux is case-sensitive. Mirrors `deckChatId` in chats.ts so a deck's
 * identity is consistent across both systems.
 */
function canonicalRootDir(p: string): string {
  const resolved = path.resolve(p)
  const ci = process.platform === 'darwin' || process.platform === 'win32'
  return ci ? resolved.toLowerCase() : resolved
}

export function findAppWindowByRootDir(rootDir: string): AppWindow | undefined {
  const key = canonicalRootDir(rootDir)
  for (const w of byWindowId.values()) {
    const d = w.getDeck()
    if (d && canonicalRootDir(d.rootDir) === key) return w
  }
  return undefined
}

export function allAppWindows(): AppWindow[] {
  return [...byWindowId.values()]
}

export function focusedAppWindow(): AppWindow | undefined {
  for (const w of byWindowId.values()) {
    if (!w.isDestroyed() && w.getBaseWindow().isFocused()) return w
  }
  return undefined
}
