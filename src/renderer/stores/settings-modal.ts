// Settings modal state. Owns:
//   - whether the modal is open
//   - the deck-view snapshot rendered underneath while it's up (so the
//     translucent overlay has a real frame to "see through" instead of
//     the empty chrome bg)
//
// The snapshot is captured *before* `open` flips true so the underlay
// is in place by the time Radix mounts the modal — otherwise there's a
// frame of empty bg behind the fade-in. `requestOpen` runs the capture
// then sets `open` in a single async flow; callers from anywhere
// (Topbar button, main-process menu push, future hotkey…) hit the same
// path without needing to know about capturePage.
//
// Living in zustand instead of CustomEvent because:
//   1. typed (open is boolean, not "did you spell the event right?")
//   2. composable — components subscribe with selectors, no listeners
//   3. cross-cuts both UI button + IPC push without a relay layer

import { create } from 'zustand'

export interface DeckSnapshot {
  dataUrl: string
  rect: { x: number; y: number; width: number; height: number }
}

interface SettingsModalStore {
  open: boolean
  /** Snapshot of the deckView painted at its last-known bounds. Cleared
   *  after the close fade so the next open captures a fresh frame. */
  snapshot: DeckSnapshot | null

  /** Capture the deck frame (if not already open), then flip `open` to
   *  true. Concurrent calls are coalesced to a single in-flight capture
   *  so two near-simultaneous triggers (e.g. user clicks Topbar button
   *  while main process menu also invokes the action) don't double-fire
   *  capturePage and risk setting a black/torn-down snapshot. */
  requestOpen: () => Promise<void>
  /** Close — leave the snapshot up; SettingsOverlay drops it after the
   *  Radix close animation has played out. */
  close: () => void
  /** Internal — drop the snapshot once the close fade has finished. */
  _clearSnapshot: () => void
}

// In-flight capture promise. Held outside the store object because it's
// purely internal coordination state — exposing it via `set` would let
// React subscribers re-render on every async tick without any UI value.
let inflightCapture: Promise<void> | null = null

export const useSettingsModal = create<SettingsModalStore>((set, get) => ({
  open: false,
  snapshot: null,
  requestOpen: () => {
    // If the modal is already open, skip the capture entirely. Re-running
    // capturePage on an already-hidden deckView (we hide it the moment
    // open flips true) would produce a black or torn-down frame and
    // overwrite the good snapshot already onscreen.
    if (get().open) return Promise.resolve()
    // Coalesce concurrent triggers onto a single capture promise.
    if (inflightCapture) return inflightCapture
    inflightCapture = (async () => {
      try {
        const snap = await window.deck.captureDeckView()
        if (snap) set({ snapshot: snap })
      } catch {
        // capturePage can fail mid-teardown; modal still opens, just
        // without the deck behind it (matches the legacy behavior).
      }
      set({ open: true })
      // Clear AFTER `open` flips so a third concurrent requestOpen
      // arriving in the microtask gap between `set({open:true})` and
      // here still short-circuits at the `get().open` check at the top
      // of the next call. Order matters.
      inflightCapture = null
    })()
    return inflightCapture
  },
  close: () => set({ open: false }),
  _clearSnapshot: () => set({ snapshot: null }),
}))
