// URL hash routing.
//
// The player's URL fragment (#<deckId>) is the source of truth for
// "which deck should be on stage". Two surfaces:
//
//   1. Imperative `Router` — owned by the host page, dispatches
//      onHash/onEmpty callbacks on popstate and on the initial load.
//      This drives Loader.
//
//   2. `useHashRoute()` — a React hook that returns the current hash
//      via useSyncExternalStore, for components that need to render
//      based on hash state without going through the imperative path.

import { useSyncExternalStore } from 'react'

export interface RouterHooks {
  /** User navigated to a hash (popstate, initial load). */
  onHash: (hash: string) => void
  /** Hash became empty — close the current deck if any. */
  onEmpty: () => void
}

export interface Router {
  /** Dispatch the initial route. Call once after Loader is wired up. */
  start: () => void
  /** Push a new history entry with `#<hash>`. */
  pushHash: (hash: string) => void
  /** Remove the hash without leaving a history entry. */
  clearHash: () => void
}

function readHash(): string {
  return location.hash.replace(/^#/, '')
}

export function createRouter({ onHash, onEmpty }: RouterHooks): Router {
  window.addEventListener('popstate', () => {
    const hash = readHash()
    if (hash) onHash(hash)
    else onEmpty()
  })

  return {
    start() {
      const initial = readHash()
      if (initial) onHash(initial)
      else onEmpty()
    },
    pushHash(hash: string) {
      history.pushState({ deckId: hash }, '', '#' + hash)
    },
    clearHash() {
      history.replaceState(null, '', location.pathname + location.search)
    },
  }
}

// ----- React hook ---------------------------------------------------

function subscribe(cb: () => void): () => void {
  window.addEventListener('hashchange', cb)
  window.addEventListener('popstate', cb)
  return () => {
    window.removeEventListener('hashchange', cb)
    window.removeEventListener('popstate', cb)
  }
}

/** Live current hash (without the leading `#`). Re-renders the caller
 *  whenever hash or popstate fires. */
export function useHashRoute(): string {
  return useSyncExternalStore(subscribe, readHash, () => '')
}
