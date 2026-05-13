// URL hash routing.
//
// The player's URL fragment (#<deckId>) is the source of truth for
// "which deck should be on stage". This module owns the popstate
// listener, push/replace operations, and the initial-load dispatch.
// The actual loading work is delegated to callbacks supplied by the
// host so this module stays free of cache/SW concerns.

/**
 * Wire up history-based routing.
 *
 * @param {{
 *   onHash:  (hash: string) => void,  // user navigated to a hash
 *                                     // (popstate, initial load,
 *                                     // explicit openHash call)
 *   onEmpty: () => void,              // hash became empty — close
 *                                     // the current deck if any
 * }} hooks
 *
 * @returns {{
 *   start: () => void,                // dispatch the initial route
 *   pushHash: (hash: string) => void, // navigate to #<hash>
 *   clearHash: () => void,            // remove hash without history
 *                                     // entry (used by close paths)
 * }}
 */
export function createRouter({ onHash, onEmpty }) {
  function readHash() { return location.hash.replace(/^#/, '') }

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
    pushHash(hash) {
      history.pushState({ deckId: hash }, '', '#' + hash)
    },
    clearHash() {
      history.replaceState(null, '', location.pathname + location.search)
    },
  }
}
