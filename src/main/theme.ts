// Main-process theme.
//
// Single source of truth for the user's theme pref. Mirrors the
// architecture of `src/main/i18n/index.ts`, with one extension: a
// `subscribeTheme` bus, because theme changes have multiple in-process
// side effects (titleBarOverlay recolor, IPC broadcast) that would
// otherwise hard-code into the IPC handler. i18n only has one
// in-process side effect (menu rebuild) so it inlines that call.
//
// The mirrored pieces:
//
//   - Pref ('auto' | 'light' | 'dark') persists to settings.json
//   - Resolved theme ('light' | 'dark') is computed here against
//     `nativeTheme.shouldUseDarkColors` when pref === 'auto'
//   - Renderers don't read localStorage / prefers-color-scheme on their
//     own — they pull `{ pref, resolved }` over IPC at boot and
//     subscribe to `app:theme-changed` for updates
//
// Why main owns this (versus the previous renderer-driven design):
//
//   - Cross-window consistency is free. Both AppWindows and the
//     Settings window subscribe to the same broadcast, so picking
//     "dark" in Settings updates every other window without each one
//     re-reading localStorage and re-running its own resolve logic.
//
//   - No prefers-color-scheme feedback loop. The previous design had
//     `nativeTheme.themeSource = 'dark'` (set by main to keep native
//     dialogs in sync) firing prefers-color-scheme change in every
//     renderer's matchMedia listener, which would re-enter `setPref`
//     and form a cycle. With main owning the resolved value, renderers
//     don't listen to matchMedia at all — main subscribes to
//     `nativeTheme.on('updated')` once and decides whether to
//     re-broadcast.
//
//   - One place to drive `nativeTheme.themeSource`. We only flip it
//     here, so callers can't accidentally double-set it from the
//     wrong process.

import { nativeTheme } from 'electron'
import { getSettings, updateSettings } from '#/main/settings.ts'

export type ThemePref = 'auto' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

export interface ThemeState {
  pref: ThemePref
  resolved: ResolvedTheme
}

type Listener = (state: ThemeState) => void

let currentPref: ThemePref = 'auto'
let currentResolved: ResolvedTheme = 'light'
const listeners = new Set<Listener>()

/**
 * Count of in-flight `setThemePref` transitions. Suppresses the
 * `nativeTheme.on('updated')` listener so an OS appearance change that
 * lands during the `await updateSettings(...)` window can't observe a
 * stale `currentPref` and broadcast a phantom `{pref:'auto', ...}`
 * state that flickers in every renderer before being overwritten by
 * the real new state a few ms later. Counter (not boolean) so two
 * back-to-back user clicks don't have the first one's `finally` clear
 * the guard while the second is still mid-flight.
 */
let transitionDepth = 0

/** True once `initTheme()` has run. Guards against duplicate listener
 *  registration on accidental second calls. */
let inited = false

function resolveTheme(pref: ThemePref): ResolvedTheme {
  if (pref === 'light' || pref === 'dark') return pref
  // `nativeTheme.shouldUseDarkColors` already factors in `themeSource` —
  // when themeSource is 'system' it reflects the OS appearance, when
  // explicit it reflects the explicit value. Either way it's the
  // single source we trust here.
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

function applyToNativeTheme(pref: ThemePref): void {
  // Drive `nativeTheme.themeSource` so native surfaces (file dialogs,
  // message boxes, the application menu on macOS) match the user's
  // pick. Without this a user who picked 'dark' would still see a
  // light "Save changes?" prompt under macOS dark-mode mismatched
  // with their app surface.
  //
  // Mapping 'auto' → 'system' lets those surfaces follow the OS.
  nativeTheme.themeSource = pref === 'auto' ? 'system' : pref
}

function emit(): void {
  const state: ThemeState = { pref: currentPref, resolved: currentResolved }
  for (const l of listeners) {
    try {
      l(state)
    } catch (err) {
      console.warn('[theme] listener threw', err)
    }
  }
}

/**
 * One-time bootstrap. Reads the persisted pref, syncs `themeSource`,
 * and starts watching `nativeTheme` for OS-level appearance changes
 * (only relevant when pref === 'auto'). Idempotent — a second call
 * would otherwise stack a duplicate `nativeTheme.on('updated')`
 * listener, doubling every emit. Call from `main.ts` before any
 * window is created.
 */
export async function initTheme(): Promise<void> {
  if (inited) return
  inited = true
  const settings = await getSettings()
  currentPref = settings.ui.theme
  applyToNativeTheme(currentPref)
  currentResolved = resolveTheme(currentPref)

  // `nativeTheme.on('updated')` fires for two reasons:
  //   (a) the OS appearance changed (System Preferences flip on macOS,
  //       prefers-color-scheme media-query change on Win/Linux), and
  //   (b) `nativeTheme.themeSource` was assigned to a different value —
  //       which we ourselves do inside `setThemePref`.
  //
  // We only care about (a), and only when pref === 'auto' (explicit
  // picks are pinned). The `transitionDepth` guard suppresses (b), and
  // the `currentPref !== 'auto'` guard rejects (a) under explicit picks.
  // The listener stays registered across all prefs so that flipping
  // back to 'auto' picks up the latest OS state without re-subscribing.
  nativeTheme.on('updated', () => {
    if (transitionDepth > 0) return
    if (currentPref !== 'auto') return
    const next = resolveTheme('auto')
    if (next === currentResolved) return
    currentResolved = next
    emit()
  })
}

export function getTheme(): ThemeState {
  return { pref: currentPref, resolved: currentResolved }
}

/**
 * Update the user pref. Persists to settings.json, syncs
 * `nativeTheme.themeSource`, recomputes `resolved`, and notifies
 * subscribers. Returns the new state.
 *
 * Idempotent — same `pref` against the same effective state is a
 * no-op; no settings.json write, no listener fire.
 */
export async function setThemePref(pref: ThemePref): Promise<ThemeState> {
  if (pref === currentPref) return { pref: currentPref, resolved: currentResolved }
  transitionDepth++
  try {
    await updateSettings({ ui: { theme: pref } })
    currentPref = pref
    applyToNativeTheme(pref)
    currentResolved = resolveTheme(pref)
    emit()
    return { pref: currentPref, resolved: currentResolved }
  } finally {
    transitionDepth--
  }
}

/**
 * Subscribe to theme changes. Returns an unsubscribe function.
 *
 * Listeners are dispatched synchronously inside `setThemePref` /
 * `nativeTheme.on('updated')`. Don't subscribe a new listener from
 * inside a listener — V8's `Set` iteration visits elements added
 * during the current pass, so the new listener would fire once on
 * this same emit before its first "real" notification, which is
 * almost never what callers expect.
 */
export function subscribeTheme(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
