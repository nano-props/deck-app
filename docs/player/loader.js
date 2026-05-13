// Deck loading pipeline.
//
// Owns the lifecycle of "which deck is on stage right now": hashing,
// unpacking, Service Worker registration, the cache hand-off, and the
// race-protection (loadGeneration) that lets a slow load bail when the
// user navigates away mid-flight.
//
// Also handles the SW restart recovery flow — if the SW evicts its
// in-memory file table, this is the module that re-registers from the
// blob cache and reloads the iframe.
//
// Talks to:
//   - cache.js   for the persistent .deck blob
//   - sw-client.js for the actual SW handoff
//   - hooks supplied by the player to update visible state (status,
//     stage, history)

import { cachePut, cacheGet, rememberName } from './cache.js'
import {
  hashBlob,
  unpackAndRegister,
  unregisterDeck,
  onDeckMissing,
  LoadCancelled,
} from './sw-client.js'

const DECK_PREFIX = 'deck'
const DECK_URL_PREFIX = './' + DECK_PREFIX + '/'

// Identify storage-full errors across browsers. Chrome/Safari throw
// DOMException with name "QuotaExceededError"; Firefox uses code 22.
function isQuotaError(err) {
  if (!err) return false
  if (err.name === 'QuotaExceededError') return true
  if (err.code === 22) return true
  return /quota/i.test(err.message || '')
}

export class Loader {
  /**
   * @param {{
   *   frameEl: HTMLIFrameElement,
   *   stageEl: HTMLElement,
   *   setStatus: (msg: string) => void,
   *   setError: (msg: string) => void,
   *   onStageShown: (deckId: string, name: string) => void,
   *   onClosed: () => void,        // close() finished tearing down
   *   onLoadFailed?: () => void,   // a load aborted with a real error
   * }} hooks
   */
  constructor(hooks) {
    this.frameEl = hooks.frameEl
    this.stageEl = hooks.stageEl
    this.setStatus = hooks.setStatus
    this.setError = hooks.setError
    this.onStageShown = hooks.onStageShown
    this.onClosed = hooks.onClosed
    this.onLoadFailed = hooks.onLoadFailed || (() => {})

    this.currentDeckId = null
    // Bumped whenever user intent changes (close, new load). Each load
    // captures the generation at start and verifies it before any state
    // mutation. See the "IMPORTANT" note in loadFromFile.
    this.loadGeneration = 0
    // One operation at a time. Subsequent attempts are dropped silently
    // rather than queued; the user can retry after the current load.
    this.isLoading = false
    // Re-entry guard for the SW recovery handler — burst of 404s after
    // a SW restart shouldn't fan out into multiple parallel re-registers.
    this.recoveryInFlight = false

    onDeckMissing((deckId) => this.recover(deckId))
  }

  get hasActiveDeck() { return this.currentDeckId !== null }

  // --- Public load entry points -----------------------------------

  /** User dropped a file or picked one. Hash, unpack, cache, show. */
  loadFromFile(file) {
    if (!file) return
    return this.withGuard(() => this.doLoadFromFile(file))
  }

  /**
   * Restore from a URL hash. The hash is the deckId; cache must have
   * the corresponding blob.
   * @returns {Promise<'restored' | 'missing'>} indicates whether the
   *   restore succeeded or fell back to a clean upload state.
   */
  loadFromHash(deckId) {
    return this.withGuard(() => this.doLoadFromHash(deckId))
  }

  /**
   * Tear down the active deck and return to the upload screen.
   * Idempotent. Bumps the load generation so any in-flight load that
   * resolves after this point is silently discarded.
   */
  close() {
    this.loadGeneration++
    if (this.currentDeckId) {
      unregisterDeck(this.currentDeckId)
      this.currentDeckId = null
    }
    this.stageEl.classList.remove('active')
    this.frameEl.src = 'about:blank'
    this.onClosed()
  }

  // --- Internals --------------------------------------------------

  // All load entry points share the same "one operation at a time"
  // guard. LoadCancelled is the in-band signal for "user navigated
  // away mid-load" and is silently absorbed.
  async withGuard(fn) {
    if (this.isLoading) return
    this.isLoading = true
    try {
      return await fn()
    } catch (err) {
      if (err instanceof LoadCancelled) return
      console.error(err)
      this.setError(err.message || String(err))
      this.onLoadFailed()
      return 'error'
    } finally {
      this.isLoading = false
    }
  }


  // Each load captures its own generation. After every async hop we
  // check it against the live `loadGeneration` to decide whether to
  // keep going. Mid-flight cancellation comes back as LoadCancelled.
  //
  // IMPORTANT: do not introduce an `await` between the final
  // isCurrent() check and the state-mutating commit (history.pushState,
  // currentDeckId, showStage). The commit must run synchronously from
  // the last check on, or a stale load could race with close().
  async doLoadFromFile(file) {
    const gen = ++this.loadGeneration
    const isCurrent = () => gen === this.loadGeneration

    this.setStatus('Hashing…')
    const deckId = await hashBlob(file)
    if (!isCurrent()) throw new LoadCancelled()

    this.setStatus('Unpacking…')
    const manifest = await unpackAndRegister(file, deckId, this.setStatus, isCurrent)
    if (!isCurrent()) {
      unregisterDeck(deckId)
      throw new LoadCancelled()
    }

    this.setStatus('Caching…')
    // Cache only after we've validated the zip is a real deck — avoids
    // polluting the cache with broken inputs.
    //
    // Quota failures are non-fatal: the deck is already registered
    // with the SW, so we can still show it this session. We just
    // won't be able to restore it on refresh, and we skip the URL
    // hash to make that visible (no hash → no false promise of
    // refresh-restore).
    let cached = true
    try {
      await cachePut(deckId, file, manifest.name)
    } catch (err) {
      if (isQuotaError(err)) {
        cached = false
        console.warn('Cache write failed (quota?). Deck will not survive a refresh:', err)
      } else {
        throw err
      }
    }
    if (!isCurrent()) {
      unregisterDeck(deckId)
      throw new LoadCancelled()
    }

    return this.commit(deckId, manifest.name, { pushHash: cached })
  }

  async doLoadFromHash(deckId) {
    const gen = ++this.loadGeneration
    const isCurrent = () => gen === this.loadGeneration

    this.setStatus('Restoring from cache…')
    const blob = await cacheGet(deckId)
    if (!isCurrent()) throw new LoadCancelled()
    if (!blob) return 'missing'

    // Switching to a different deck via a hash change: release the
    // SW's file table for the previous one before we register the new.
    if (this.currentDeckId && this.currentDeckId !== deckId) {
      unregisterDeck(this.currentDeckId)
    }

    this.setStatus('Unpacking…')
    const manifest = await unpackAndRegister(blob, deckId, this.setStatus, isCurrent)
    if (!isCurrent()) {
      unregisterDeck(deckId)
      throw new LoadCancelled()
    }
    // Backfill the name in case this entry pre-dates name tracking.
    rememberName(deckId, manifest.name)

    this.commit(deckId, manifest.name, { pushHash: false })
    return 'restored'
  }

  // Synchronous commit step — see the "IMPORTANT" note above.
  commit(deckId, manifestName, { pushHash }) {
    if (pushHash) {
      // Push a new history entry so the browser back button can also
      // return to upload. The in-app palette doesn't rely on this
      // (decks may mutate history themselves).
      history.pushState({ deckId }, '', '#' + deckId)
    }
    this.currentDeckId = deckId
    this.frameEl.src = DECK_URL_PREFIX + deckId + '/index.html'
    this.stageEl.classList.add('active')
    this.setStatus('')
    this.onStageShown(deckId, manifestName)
  }

  // SW restart recovery. The SW posts "deck-missing" on the first 404
  // after its in-memory registry was wiped (idle eviction etc). We
  // re-register from the cached blob, then reload the iframe so the
  // resources that 404'd in the meantime are re-fetched.
  async recover(deckId) {
    if (deckId !== this.currentDeckId || this.recoveryInFlight) return
    this.recoveryInFlight = true
    try {
      const blob = await cacheGet(deckId)
      if (!blob || deckId !== this.currentDeckId) return
      await unpackAndRegister(
        blob, deckId,
        () => {},
        () => deckId === this.currentDeckId,
      )
      if (deckId !== this.currentDeckId) {
        unregisterDeck(deckId)
        return
      }
      // Force the iframe to refetch from the freshly-registered table.
      // Setting src to the same URL is enough — the browser treats it
      // as a navigation and reissues all subresource requests.
      this.frameEl.src = DECK_URL_PREFIX + deckId + '/index.html'
    } catch (err) {
      if (err instanceof LoadCancelled) return
      console.error('Failed to re-register deck after SW restart:', err)
    } finally {
      this.recoveryInFlight = false
    }
  }
}
