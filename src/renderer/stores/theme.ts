// Theme preference store. Mirrors the inline boot script in index.html
// — that script runs first to avoid a white flash before React mounts;
// this store owns subsequent changes.
//
// Persistence:
//   - Pref ('auto'|'light'|'dark') in localStorage as `deck:theme`
//   - Resolved theme reflected on `<html data-theme>`
//   - Push to main via `setChromeTheme` so the Win/Linux titleBarOverlay
//     recolors (deck windows only — Settings window uses a default OS
//     titlebar with no overlay)

import { create } from 'zustand'

export type ThemePref = 'auto' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

const LS_KEY = 'deck:theme'

function resolveTheme(pref: ThemePref): ResolvedTheme {
  if (pref === 'light' || pref === 'dark') return pref
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function readPref(): ThemePref {
  const v = localStorage.getItem(LS_KEY)
  return v === 'light' || v === 'dark' || v === 'auto' ? v : 'auto'
}

interface ThemeStore {
  pref: ThemePref
  resolved: ResolvedTheme
  setPref: (pref: ThemePref) => void
}

const initialPref = readPref()
const initialResolved = resolveTheme(initialPref)

export const useTheme = create<ThemeStore>((set) => ({
  pref: initialPref,
  resolved: initialResolved,
  setPref: (pref) => {
    localStorage.setItem(LS_KEY, pref)
    const resolved = resolveTheme(pref)
    document.documentElement.setAttribute('data-theme', resolved)
    void window.deck.setChromeTheme?.(resolved).catch(() => {})
    set({ pref, resolved })
  },
}))

/** Push the current resolved theme to main once on boot, so the native
 *  titleBarOverlay (Win/Linux) matches before any user interaction.
 *
 *  Called explicitly from the deck AppWindow's renderer entry only
 *  (`main.tsx`). The Settings window has no titleBarOverlay to recolor
 *  — calling this from there would just trigger a no-op IPC and an
 *  unnecessary cross-window theme broadcast. */
export function pushInitialChromeTheme(): void {
  void window.deck.setChromeTheme?.(initialResolved).catch(() => {})
}

// Auto follows system theme changes.
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  if (useTheme.getState().pref === 'auto') useTheme.getState().setPref('auto')
})

// Cross-window theme sync. Another window (typically the Settings
// window) wrote a new theme choice; main broadcasts it here. localStorage
// is shared across same-origin BrowserWindows so the pref is already
// the new value — we just need to update this window's React state and
// DOM. We deliberately do NOT route through `setPref`: that would push
// `setChromeTheme` back to main, which would re-broadcast to the rest
// of the windows, fanning out an O(N²) IPC echo. The native overlay
// for THIS window is updated separately by main (it walks every
// AppWindow when the originating sender wasn't an AppWindow).
window.deck.onThemeChanged?.((theme) => {
  const stored = localStorage.getItem(LS_KEY)
  const pref: ThemePref = stored === 'light' || stored === 'dark' || stored === 'auto' ? stored : 'auto'
  // `theme` is the resolved value the sender computed; trust it for
  // data-theme, but recompute from `pref` if `pref === 'auto'` so we
  // honor THIS window's system theme (which may differ if the user
  // dragged the window across displays with different appearances).
  const resolved = pref === 'auto' ? resolveTheme(pref) : theme
  document.documentElement.setAttribute('data-theme', resolved)
  useTheme.setState({ pref, resolved })
})
