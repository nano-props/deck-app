// App-state store — mirrors what `main` broadcasts via `app:state`.
//
// Single source of truth for `mode` / `subView` / `deck` / `loading` /
// `isFullScreen`. The store subscribes to `window.deck.onState` once on
// module load; components select the slices they care about via the
// usual zustand pattern.

import { create } from 'zustand'
import type { AppState } from '#/main/app-window/index.ts'

interface AppStore extends AppState {
  /** Replace state from a main-broadcast push. Internal — components
   *  should never mutate state directly. */
  _setFromMain: (next: AppState) => void
}

const INITIAL: AppState = {
  mode: 'launcher',
  subView: 'edit',
  deck: null,
  loading: false,
  isFullScreen: false,
  dirty: false,
}

export const useAppStore = create<AppStore>((set) => ({
  ...INITIAL,
  _setFromMain: (next) => set(next),
}))

// One-time subscription to the main-side broadcast. `window.deck.onState`
// returns an unsubscribe function we ignore — the listener lives for the
// lifetime of the renderer process.
window.deck.onState((s) => {
  useAppStore.getState()._setFromMain(s)
})

// Pull initial snapshot. The push above will eventually deliver the
// same data, but `getState()` is the fast path on a cold load.
void window.deck.getState().then((s) => {
  if (s) useAppStore.getState()._setFromMain(s)
})
