// Theme store — `pref` is what the user chose ('light' | 'dark' |
// 'auto'); `resolved` is what should actually paint on the page.
//
// 'auto' follows the OS preference live — we subscribe to
// `matchMedia('(prefers-color-scheme: dark)')` and re-resolve when it
// flips. Persistence is plain localStorage; the inline boot script in
// each entry HTML reads the same key synchronously so first paint
// already shows the right theme (no flash).

import { create } from 'zustand'

export type ThemePref = 'light' | 'dark' | 'auto'
export type ResolvedTheme = 'light' | 'dark'

const LS_KEY = 'theme'

function readPref(): ThemePref {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'auto') return raw
  } catch {
    // localStorage unavailable; fall through to 'auto'.
  }
  return 'auto'
}

function systemDark(): boolean {
  return (
    typeof matchMedia !== 'undefined' &&
    matchMedia('(prefers-color-scheme: dark)').matches
  )
}

function resolve(pref: ThemePref): ResolvedTheme {
  if (pref === 'auto') return systemDark() ? 'dark' : 'light'
  return pref
}

function apply(resolved: ResolvedTheme) {
  document.documentElement.setAttribute('data-theme', resolved)
}

interface ThemeStore {
  pref: ThemePref
  resolved: ResolvedTheme
  setPref: (next: ThemePref) => void
  /** Cycle through light → dark → auto → light. Mirrors the homepage's
   *  single-button toggle — kept here so both ThemeToggle (homepage)
   *  and any future player toggle share the rotation. */
  cycle: () => void
}

export const useTheme = create<ThemeStore>((set, get) => {
  const pref = readPref()
  const resolved = resolve(pref)
  apply(resolved)

  // OS-preference listener: only takes effect when pref === 'auto'.
  // Always installed (cheap — one MQ listener) so a 'dark'/'light' user
  // who later switches back to 'auto' picks up the system value
  // immediately without us re-binding.
  if (typeof matchMedia !== 'undefined') {
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => {
      if (get().pref !== 'auto') return
      const next: ResolvedTheme = mq.matches ? 'dark' : 'light'
      apply(next)
      set({ resolved: next })
    }
    // Modern browsers emit `change`; the older `addListener` shim isn't
    // needed for any browser we ship to.
    mq.addEventListener('change', onChange)
  }

  return {
    pref,
    resolved,
    setPref: (next: ThemePref) => {
      try {
        localStorage.setItem(LS_KEY, next)
      } catch {
        // Quota / disabled storage; still apply to in-memory state.
      }
      const r = resolve(next)
      apply(r)
      set({ pref: next, resolved: r })
    },
    cycle: () => {
      const order: ThemePref[] = ['light', 'dark', 'auto']
      const idx = order.indexOf(get().pref)
      const next = order[(idx + 1) % order.length]
      get().setPref(next)
    },
  }
})
