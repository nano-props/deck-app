/**
 * Process-wide constants and small helpers shared by AppWindow and the
 * code that creates child views. Kept separate from the AppWindow module
 * so the latter can focus on the window class itself.
 */

import { app, nativeTheme } from 'electron'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'

export const APP_ICON = app.isPackaged
  ? path.join(process.resourcesPath, 'assets', 'icon.png')
  : path.join(import.meta.dirname, '..', '..', 'assets', 'icon.png')

export const CHROME_PRELOAD = path.join(import.meta.dirname, '..', 'preload', 'app-preload.js')
// React renderer is built into `dist/renderer/index.html` by Vite.
// `import.meta.dirname` is `src/main` in dev (running TS directly via tsx)
// and packaged ASAR `app/src/main` after electron-builder. In both cases
// the renderer bundle sits two levels up at `dist/renderer/`.
export const CHROME_HTML = path.join(import.meta.dirname, '..', '..', 'dist', 'renderer', 'index.html')

/**
 * Secure defaults shared by every WebContentsView we create.
 *
 * `sandbox` is deliberately NOT set here: the chromeView turns it off so
 * its preload can `require` npm modules (marked / dompurify for chat
 * Markdown rendering), while the deckView keeps it on. Both views still
 * have `contextIsolation: true` + `nodeIntegration: false`, so an XSS
 * in a deck page still can't reach Node.
 */
export const sharedWebPreferences = {
  contextIsolation: true,
  nodeIntegration: false,
} as const

/**
 * Matches `styles.css` `--color-bg` for each theme. BaseWindow + chromeView
 * take this as their raw backing color so a freshly-shown window doesn't
 * flash white before the renderer's CSS applies. `nativeTheme.shouldUseDarkColors`
 * is our best guess at this moment — the renderer can still flip
 * `data-theme` afterward if the user picked a non-auto preference.
 */
export function appCanvasBg(): string {
  return nativeTheme.shouldUseDarkColors ? '#0c0d0f' : '#f7f7f5'
}

/** Rect in window content-area coordinates (CSS pixels). */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Does a path look like a deck (file .deck or dir with deck.json)?
 *
 * This is the only gate between the `app:open-path` IPC and
 * `loadDeck()`. We deliberately do NOT add a directory-prefix whitelist
 * (e.g. only home / Documents): users legitimately keep decks on
 * external volumes, network mounts, project directories, etc. — and
 * the format check below already prevents weaponizing this into a
 * generic file-read primitive.
 *
 * To return non-null, an attacker would need to plant either a `.deck`
 * file or a `deck.json` at the target path. If they have that level of
 * filesystem write access, opening a malformed deck is the least of
 * the user's worries — they already have arbitrary code execution via
 * the deck's index.html.
 *
 * Hardening that *would* matter and is therefore worthwhile:
 *   - keep this validator strict (don't accept arbitrary directories)
 *   - keep the deck server origin-locked (see deck-view.ts)
 *   - keep `loadDeck` from following symlinks out of its own root
 */
export function isDeckPath(p: string): 'file' | 'dir' | null {
  try {
    const resolved = path.resolve(p)
    if (!existsSync(resolved)) return null
    const s = statSync(resolved)
    if (s.isFile() && resolved.toLowerCase().endsWith('.deck')) return 'file'
    if (s.isDirectory() && existsSync(path.join(resolved, 'deck.json'))) return 'dir'
  } catch {
    // not a real path
  }
  return null
}
