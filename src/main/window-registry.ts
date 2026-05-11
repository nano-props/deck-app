import { webContents, type WebContents } from 'electron'
import type { AppWindow } from '#/main/app-window/index.ts'
import { canonicalPath } from '#/main/util/path-identity.ts'

/**
 * Global registry of live `AppWindow` instances. Kept outside the AppWindow
 * module so the class definition isn't cluttered with map bookkeeping, and
 * so that IPC handlers / menu actions have a single, side-effect-free place
 * to look windows up.
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

/**
 * WebContents ids belonging to auxiliary chrome windows (today: the
 * Settings window). They share the same preload + IPC surface as
 * AppWindow's chromeView and need to pass `chromeOnly`, but they are
 * not associated with a deck — so they're tracked here separately
 * rather than in `byChromeWcId`.
 */
const auxChromeWcIds = new Set<number>()

/**
 * Source paths whose `openDeck` is mid-flight in some window. Holds the
 * canonicalized form so the across-window mutual-exclusion check (in
 * `openDeck`) can detect "another window is currently in the middle of
 * opening this same deck", not just "another window has finished
 * opening it".
 *
 * Without this, two windows that race to open the same `.deck` both
 * pass the `findAppWindowBySourcePath` check (neither has set its
 * `deck` yet) and proceed to extract independently into different
 * tmpdirs — two servers, two AI sessions, two close-time rezips
 * stomping each other.
 *
 * `claimOpening(sourcePath)` returns true if we got the slot; the
 * caller is responsible for `releaseOpening` exactly once when the
 * flow ends (success or failure).
 */
const openingSourcePaths = new Set<string>()

export function isOpeningSourcePath(sourcePath: string): boolean {
  return openingSourcePaths.has(canonicalPath(sourcePath))
}

/** Try to reserve the in-flight slot. Returns false if already taken. */
export function claimOpening(sourcePath: string): boolean {
  const key = canonicalPath(sourcePath)
  if (openingSourcePaths.has(key)) return false
  openingSourcePaths.add(key)
  return true
}

/** Release the in-flight slot. Idempotent. */
export function releaseOpening(sourcePath: string): void {
  openingSourcePaths.delete(canonicalPath(sourcePath))
}

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

export function appWindowByWebContents(wc: WebContents): AppWindow | undefined {
  return byChromeWcId.get(wc.id)
}

/**
 * True if `wc` is one of our registered chrome WebContents — either an
 * AppWindow's chromeView or an auxiliary window (Settings). Used as the
 * `validateSender` check on every `ipcMain.handle` — only our own chrome
 * (loaded from the renderer bundle with our preload) is allowed to invoke
 * handlers. Deck content runs in a separate WebContentsView without a
 * preload, so it can't reach `ipcRenderer`, but this guard makes that
 * property structural rather than configurational (Electron security
 * checklist #17).
 */
export function isChromeWebContents(wc: WebContents): boolean {
  return byChromeWcId.has(wc.id) || auxChromeWcIds.has(wc.id)
}

/** Register / unregister an auxiliary chrome WebContents (Settings window). */
export function registerAuxChromeWebContents(wcId: number): void {
  auxChromeWcIds.add(wcId)
}
export function unregisterAuxChromeWebContents(wcId: number): void {
  auxChromeWcIds.delete(wcId)
}

/**
 * Iterate every chrome WebContents id registered with us, AppWindow and
 * auxiliary alike. Used by `broadcastToChromeWebContents` and rare
 * direct callers that need the id list (e.g. to filter by sender id).
 */
export function allChromeWebContentsIds(): number[] {
  return [...byChromeWcId.keys(), ...auxChromeWcIds]
}

/**
 * Send `channel` (with optional `args`) to every registered chrome
 * WebContents — both AppWindow chromes and auxiliary windows. Skips
 * destroyed WCs, swallows per-WC send failures, and lets callers
 * exclude a specific id (typically the IPC sender, to avoid echo).
 *
 * Best-effort: the message is dropped silently for any WebContents that
 * is still loading (Chromium discards `send` before the renderer has
 * registered its listener). Callers MUST therefore use this only for
 * "advisory" channels where every consumer also has a boot-time pull
 * path — i18n.get, theme localStorage read, ai-readiness probe — so a
 * dropped broadcast is recovered when the new window finishes loading.
 * Don't use it for state that has no fallback fetch.
 */
export function broadcastToChromeWebContents(
  channel: string,
  args: unknown[] = [],
  options?: { excludeId?: number },
): void {
  for (const id of allChromeWebContentsIds()) {
    if (options?.excludeId === id) continue
    const wc = webContents.fromId(id)
    if (!wc || wc.isDestroyed()) continue
    try {
      wc.send(channel, ...args)
    } catch {
      // teardown race — destroyed between the check and the send
    }
  }
}

/**
 * Look up a window by the deck's source path — i.e. the `.deck` file or
 * Source directory the user opened. NOT keyed by `rootDir`, because for
 * a Pack `rootDir` is a per-open tmpdir that differs across opens of
 * the same `.deck`; we'd fail to detect "already open" and let the same
 * file load into two windows.
 */
export function findAppWindowBySourcePath(sourcePath: string): AppWindow | undefined {
  const key = canonicalPath(sourcePath)
  for (const w of byWindowId.values()) {
    const d = w.getDeck()
    if (d && canonicalPath(d.sourcePath) === key) return w
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
