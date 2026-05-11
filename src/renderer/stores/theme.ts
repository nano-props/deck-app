// Theme store — pure subscriber to main's theme module.
//
// Main owns the persisted pref (settings.json), the resolved value, and
// `nativeTheme.themeSource`. The renderer:
//
//   1. Seeds `pref` + `resolved` synchronously from `<html
//      data-theme-pref>` / `<html data-theme>`, which the inline boot
//      script in index.html / settings.html stamped from the
//      `?theme=&themePref=` query supplied by main on `loadFile`.
//      No IPC roundtrip, no localStorage, no white flash, and the
//      Segmented control in Settings shows the right selection on
//      the very first render.
//   2. Pulls the full `{ pref, resolved }` over IPC after mount, in
//      case the URL seed is somehow stale (it shouldn't be, but the
//      fetch also covers any window that loaded while a sibling
//      window was mid-`setPref` and whose broadcast was dropped due
//      to webContents-still-loading semantics).
//   3. Listens for `app:theme-changed` broadcasts and re-applies.
//   4. Sends user picks through `setPref` → IPC → main; main emits
//      back through the same broadcast that step 3 listens for, so
//      the React update is single-pass.
//
// What this file deliberately does NOT do:
//
//   - No `localStorage` read/write. Persistence lives in main.
//   - No `matchMedia('(prefers-color-scheme)')` listener. Main owns
//     the OS-appearance subscription and broadcasts the resolved value
//     when pref === 'auto' and the system flips. A renderer-side
//     listener would form a feedback loop with `nativeTheme.themeSource`.
//   - No optimistic local update inside `setPref`. We wait for main's
//     broadcast — this is the same single-source pattern i18n uses
//     (see `i18n.ts`) and keeps every window in lockstep.

import { create } from 'zustand'
import type { ResolvedTheme, ThemePref, ThemeState } from '#/main/theme.ts'

// Re-export so other renderer files can grab these without reaching
// into `#/main/...` themselves — keeps the type-import surface narrow.
export type { ResolvedTheme, ThemePref } from '#/main/theme.ts'

interface ThemeStore extends ThemeState {
  setPref: (pref: ThemePref) => Promise<void>
  /** Internal — applied on `app:theme-changed` and the boot fetch. */
  _apply: (state: ThemeState) => void
}

// Seed `pref` and `resolved` from the DOM attributes the inline boot
// script in index.html / settings.html already stamped (sourced from
// the `?theme=&themePref=` query main injects on loadFile — see
// window-shell.ts). Both seeds match main's canonical state, so
// components like AppearanceTab's Segmented control select the right
// option on the very first render without waiting for the boot fetch
// to round-trip.
function readInitialState(): ThemeState {
  const resolved: ResolvedTheme =
    document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
  const prefAttr = document.documentElement.getAttribute('data-theme-pref')
  const pref: ThemePref = prefAttr === 'dark' || prefAttr === 'light' || prefAttr === 'auto' ? prefAttr : 'auto'
  return { pref, resolved }
}

export const useTheme = create<ThemeStore>((set) => ({
  ...readInitialState(),
  setPref: async (pref) => {
    // Don't update local state here — main will broadcast the canonical
    // result and `_apply` will land it. Same pattern as i18n.setPref.
    await window.deck.theme.setPref(pref).catch(() => {})
  },
  _apply: ({ pref, resolved }) => {
    document.documentElement.setAttribute('data-theme', resolved)
    set({ pref, resolved })
  },
}))

window.deck.theme.onChange((payload) => {
  if (payload) useTheme.getState()._apply(payload)
})

// Boot fetch. Belt-and-braces with the URL-seeded initial state above:
// the seed is already correct in normal flow, but the fetch also covers
// the (rare) case where a sibling window's setPref broadcast was
// dropped because this webContents was still loading at the time. The
// fetch result is the same payload the broadcast would have carried,
// so applying it idempotently lands consistency.
//
// Same fire-and-forget shape as i18n's boot fetch (see i18n.ts) — a
// rejection here is exceptional (main's IPC down before renderer boot
// finishes) and the global `unhandledrejection` listener in main.tsx
// logs it. The broadcast path recovers consistency on the next theme
// change either way.
void window.deck.theme.get().then((payload) => {
  if (payload) useTheme.getState()._apply(payload)
})
