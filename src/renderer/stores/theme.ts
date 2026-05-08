// Theme preference store. Mirrors the inline boot script in index.html
// — that script runs first to avoid a white flash before React mounts;
// this store owns subsequent changes.
//
// Persistence:
//   - Pref ('auto'|'light'|'dark') in localStorage as `deck:theme`
//   - Resolved theme reflected on `<html data-theme>`
//   - Push to main via `setChromeTheme` so the Win/Linux titleBarOverlay
//     recolors

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

export const useTheme = create<ThemeStore>((set, get) => ({
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

// Apply on boot — index.html sets data-theme too, but only `pref` was in
// localStorage. We push the resolved theme to main so the native
// titleBarOverlay matches.
void window.deck.setChromeTheme?.(initialResolved).catch(() => {})

// Auto follows system theme changes.
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  if (useTheme.getState().pref === 'auto') useTheme.getState().setPref('auto')
})
