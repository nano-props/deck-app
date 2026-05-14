// Player-side UI state. Bridges the imperative Loader class to React.
//
// Loader still owns deck-loading semantics (isLoading guard,
// loadGeneration race protection — see loader.ts). This store is the
// thin reactive surface React components subscribe to: status text,
// last error, the active deckId, and a cached deck name for the page
// title. Loader writes here through its hooks; nothing else does.
//
// Recents are NOT in this store — they live in the Cache API + LRU.
// Components fetch them via listRecents() and re-fetch on a manual
// `bumpRecents` tick (incremented by the player after add/delete).

import { create } from 'zustand'

interface PlayerState {
  status: string
  error: string
  /** Set once Loader.commit lands — drives <Stage> visibility and the
   *  document.title. Cleared on Loader.close(). */
  activeDeckId: string | null
  activeDeckName: string
  /** Bumped by the player whenever the recents list should be re-read
   *  (load, delete, undo). Components listen and re-call listRecents. */
  recentsTick: number
  setStatus: (msg: string) => void
  setError: (msg: string) => void
  setActive: (id: string | null, name?: string) => void
  bumpRecents: () => void
}

export const usePlayer = create<PlayerState>((set) => ({
  status: '',
  error: '',
  activeDeckId: null,
  activeDeckName: '',
  recentsTick: 0,
  // Status and error are mutually exclusive: setting one clears the
  // other so users never see "Loading…" alongside a final error.
  setStatus: (msg: string) => {
    if (msg) set({ status: msg, error: '' })
    else set({ status: '' })
  },
  setError: (msg: string) => {
    if (msg) set({ error: msg, status: '' })
    else set({ error: '' })
  },
  setActive: (id: string | null, name = '') =>
    set({ activeDeckId: id, activeDeckName: name }),
  bumpRecents: () => set((s) => ({ recentsTick: s.recentsTick + 1 })),
}))
