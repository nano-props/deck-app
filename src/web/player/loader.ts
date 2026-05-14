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

import { cachePut, cacheGet, rememberName } from '#/web/player/cache.ts'
import {
  hashBlob,
  unpackAndRegister,
  unregisterDeck,
  onDeckMissing,
  LoadCancelled,
} from '#/web/player/sw-client.ts'
import { getT } from '#/web/lib/i18n.ts'

const DECK_PREFIX = 'deck'
const DECK_URL_PREFIX = './' + DECK_PREFIX + '/'

// Identify storage-full errors across browsers. Chrome/Safari throw
// DOMException with name "QuotaExceededError"; Firefox uses code 22.
function isQuotaError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { name?: string; code?: number; message?: string }
  if (e.name === 'QuotaExceededError') return true
  if (e.code === 22) return true
  return /quota/i.test(e.message || '')
}

export interface LoaderHooks {
  frameEl: HTMLIFrameElement
  setStatus: (msg: string) => void
  setError: (msg: string) => void
  onStageShown: (deckId: string, manifestName: string) => void
  /** close() finished tearing down. */
  onClosed: () => void
  /** A load aborted with a real error (not LoadCancelled). */
  onLoadFailed?: () => void
}

export type LoadResult = 'restored' | 'missing' | 'error' | undefined

export class Loader {
  private frameEl: HTMLIFrameElement
  private setStatus: (msg: string) => void
  private setError: (msg: string) => void
  private onStageShown: (deckId: string, manifestName: string) => void
  private onClosed: () => void
  private onLoadFailed: () => void

  currentDeckId: string | null = null
  /** Bumped whenever user intent changes (close, new load). Each load
   *  captures the generation at start and verifies it before any state
   *  mutation. See the "IMPORTANT" note in doLoadFromFile. */
  private loadGeneration = 0
  /** One operation at a time. Subsequent attempts are dropped silently
   *  rather than queued; the user can retry after the current load. */
  private isLoading = false
  /** Re-entry guard for the SW recovery handler — burst of 404s after
   *  a SW restart shouldn't fan out into multiple parallel
   *  re-registers. */
  private recoveryInFlight = false

  constructor(hooks: LoaderHooks) {
    this.frameEl = hooks.frameEl
    this.setStatus = hooks.setStatus
    this.setError = hooks.setError
    this.onStageShown = hooks.onStageShown
    this.onClosed = hooks.onClosed
    this.onLoadFailed = hooks.onLoadFailed || (() => {})

    onDeckMissing((deckId) => {
      void this.recover(deckId)
    })
  }

  get hasActiveDeck(): boolean {
    return this.currentDeckId !== null
  }

  /** User dropped a file or picked one. Hash, unpack, cache, show. */
  loadFromFile(file: File | null | undefined): Promise<LoadResult> {
    if (!file) return Promise.resolve(undefined)
    return this.withGuard(() => this.doLoadFromFile(file))
  }

  /**
   * Restore from a URL hash. The hash is the deckId; cache must have
   * the corresponding blob. Returns `'restored'` or `'missing'`.
   */
  loadFromHash(deckId: string): Promise<LoadResult> {
    return this.withGuard(() => this.doLoadFromHash(deckId))
  }

  /**
   * Tear down the active deck and return to the upload screen.
   * Idempotent. Bumps the load generation so any in-flight load that
   * resolves after this point is silently discarded.
   */
  close(): void {
    this.loadGeneration++
    if (this.currentDeckId) {
      unregisterDeck(this.currentDeckId)
      this.currentDeckId = null
    }
    this.frameEl.src = 'about:blank'
    this.onClosed()
  }

  // --- Internals --------------------------------------------------

  // All load entry points share the same "one operation at a time"
  // guard. LoadCancelled is the in-band signal for "user navigated
  // away mid-load" and is silently absorbed.
  private async withGuard(fn: () => Promise<LoadResult>): Promise<LoadResult> {
    if (this.isLoading) return undefined
    this.isLoading = true
    try {
      return await fn()
    } catch (err) {
      if (err instanceof LoadCancelled) return undefined
      console.error(err)
      const message =
        err instanceof Error ? err.message : String(err)
      this.setError(message)
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
  private async doLoadFromFile(file: File): Promise<LoadResult> {
    const t = getT()
    const gen = ++this.loadGeneration
    const isCurrent = () => gen === this.loadGeneration

    this.setStatus(t('statusHashing'))
    const deckId = await hashBlob(file)
    if (!isCurrent()) throw new LoadCancelled()

    this.setStatus(t('statusUnpacking'))
    const manifest = await unpackAndRegister(file, deckId, this.setStatus, isCurrent)
    if (!isCurrent()) {
      unregisterDeck(deckId)
      throw new LoadCancelled()
    }

    this.setStatus(t('statusCaching'))
    // Cache only after we've validated the zip is a real deck — avoids
    // polluting the cache with broken inputs.
    //
    // Quota failures are non-fatal: the deck is already registered
    // with the SW, so we can still show it this session. We just won't
    // be able to restore it on refresh, and we skip the URL hash to
    // make that visible (no hash → no false promise of refresh-restore).
    let cached = true
    try {
      await cachePut(deckId, file, manifest.name)
    } catch (err) {
      if (isQuotaError(err)) {
        cached = false
        console.warn(
          'Cache write failed (quota?). Deck will not survive a refresh:',
          err,
        )
      } else {
        throw err
      }
    }
    if (!isCurrent()) {
      unregisterDeck(deckId)
      throw new LoadCancelled()
    }

    this.commit(deckId, manifest.name, { pushHash: cached })
    return undefined
  }

  private async doLoadFromHash(deckId: string): Promise<LoadResult> {
    const t = getT()
    const gen = ++this.loadGeneration
    const isCurrent = () => gen === this.loadGeneration

    this.setStatus(t('statusRestoring'))
    const blob = await cacheGet(deckId)
    if (!isCurrent()) throw new LoadCancelled()
    if (!blob) return 'missing'

    // Switching to a different deck via a hash change: release the
    // SW's file table for the previous one before we register the new.
    if (this.currentDeckId && this.currentDeckId !== deckId) {
      unregisterDeck(this.currentDeckId)
    }

    this.setStatus(t('statusUnpacking'))
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
  private commit(deckId: string, manifestName: string, opts: { pushHash: boolean }): void {
    if (opts.pushHash) {
      // Push a new history entry so the browser back button can also
      // return to upload. The in-app palette doesn't rely on this
      // (decks may mutate history themselves).
      history.pushState({ deckId }, '', '#' + deckId)
    }
    this.currentDeckId = deckId
    this.frameEl.src = DECK_URL_PREFIX + deckId + '/index.html'
    this.setStatus('')
    this.onStageShown(deckId, manifestName)
  }

  // SW restart recovery. The SW posts "deck-missing" on the first 404
  // after its in-memory registry was wiped (idle eviction etc). We
  // re-register from the cached blob, then reload the iframe so the
  // resources that 404'd in the meantime are re-fetched.
  private async recover(deckId: string): Promise<void> {
    if (deckId !== this.currentDeckId || this.recoveryInFlight) return
    this.recoveryInFlight = true
    try {
      const blob = await cacheGet(deckId)
      if (!blob || deckId !== this.currentDeckId) return
      await unpackAndRegister(
        blob,
        deckId,
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
