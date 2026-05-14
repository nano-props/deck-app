// Persistent cache for deck blobs + LRU bookkeeping.
//
// Two stores work together:
//   - Cache API: holds the raw .deck zip Blob keyed by a synthetic URL.
//   - localStorage: { [deckId]: { ts, name } } — lets us order entries
//     by recency and surface a human-readable name in the recents list.
//
// They can drift if the user manually clears one but not the other; the
// recents UI compensates by intersecting the two before rendering.

// Cache and storage names are versioned. They are NOT prefixed with the
// app name because they predate that convention — renaming would orphan
// existing user data with no way to clean it up. New keys added later
// should use a "deckplayer:" prefix.
export const CACHE_NAME = 'deck-blobs-v1'
// Synthetic URL key used inside the Cache API. The Service Worker MUST
// NOT intercept this prefix — it's only a key, not a real request path.
export const CACHE_URL_PREFIX = '/__deck_blob__/'

const LRU_KEY = 'deck-cache-lru-v2'
const MAX_CACHED_DECKS = 20

export interface LruEntry {
  ts: number
  name: string
}
type LruMap = Record<string, LruEntry>

export interface RecentItem {
  id: string
  name: string
  ts: number
}

// Reuse the same Cache object across all operations. caches.open() is
// promise-based and cheap, but doing it once per call hits the
// implementation's bookkeeping repeatedly for no benefit.
let cachePromise: Promise<Cache> | null = null
function getCache(): Promise<Cache> {
  if (!cachePromise) cachePromise = caches.open(CACHE_NAME)
  return cachePromise
}

function readLru(): LruMap {
  try {
    const raw = localStorage.getItem(LRU_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as LruMap) : {}
  } catch {
    return {}
  }
}

function writeLru(lru: LruMap): void {
  try {
    localStorage.setItem(LRU_KEY, JSON.stringify(lru))
  } catch {
    // Quota or disabled storage — non-fatal; eviction just won't run.
  }
}

function touchLru(deckId: string, name?: string): void {
  const lru = readLru()
  const prev = lru[deckId] || { ts: 0, name: '' }
  lru[deckId] = {
    ts: Date.now(),
    name: name || prev.name || '',
  }
  writeLru(lru)
}

async function evictIfNeeded(): Promise<void> {
  const cache = await getCache()
  const requests = await cache.keys()
  if (requests.length <= MAX_CACHED_DECKS) return

  // Pair every actual cache entry with its recorded access time.
  // Entries missing from the LRU map (e.g. left over from earlier
  // versions) get timestamp 0 and are evicted first.
  const lru = readLru()
  const items = requests.map((req) => {
    const url = new URL(req.url)
    const id = url.pathname.slice(CACHE_URL_PREFIX.length)
    const entry = lru[id]
    return { req, id, ts: (entry && entry.ts) || 0 }
  })
  items.sort((a, b) => a.ts - b.ts)

  const toEvict = items.slice(0, items.length - MAX_CACHED_DECKS)
  await Promise.all(
    toEvict.map(async ({ req, id }) => {
      await cache.delete(req)
      delete lru[id]
    }),
  )
  writeLru(lru)
}

export async function cachePut(deckId: string, blob: Blob, name: string): Promise<void> {
  const cache = await getCache()
  await cache.put(CACHE_URL_PREFIX + deckId, new Response(blob))
  touchLru(deckId, name)
  await evictIfNeeded()
}

export async function cacheGet(deckId: string): Promise<Blob | null> {
  const cache = await getCache()
  const res = await cache.match(CACHE_URL_PREFIX + deckId)
  if (!res) return null
  touchLru(deckId)
  return await res.blob()
}

/** Backfill the deck name on an existing entry without touching its
 *  blob. Used after restoring from a hash, where the manifest is only
 *  known after unpacking. */
export function rememberName(deckId: string, name: string): void {
  touchLru(deckId, name)
}

/**
 * Soft-delete: remove the deck from the LRU map (so it disappears from
 * listRecents) but leave the cached blob alone. Returns the LRU entry
 * that was removed, so the caller can stash it for a possible undo.
 * Returns null if no such entry existed.
 */
export function softDeleteDeck(deckId: string): LruEntry | null {
  const lru = readLru()
  const entry = lru[deckId]
  if (!entry) return null
  delete lru[deckId]
  writeLru(lru)
  return entry
}

/**
 * Restore a soft-deleted entry. The cached blob was never deleted, so
 * we only need to put the LRU entry back.
 */
export function restoreDeck(deckId: string, entry: LruEntry): void {
  if (!entry) return
  const lru = readLru()
  lru[deckId] = entry
  writeLru(lru)
}

/**
 * Hard-delete: remove the cached blob. Call this after a soft-delete
 * has aged out without being undone.
 *
 * If `softEntry` is supplied, we only commit the delete when the LRU
 * still doesn't know about this deckId, OR when the entry it knows
 * about hasn't been touched since the soft-delete. This protects the
 * "delete A → immediately re-open A → undo timer fires later" flow
 * from wiping the just-re-opened deck.
 *
 * Idempotent — safe to call even if the cache entry is already gone.
 */
export async function commitDeleteDeck(deckId: string, softEntry?: LruEntry): Promise<void> {
  if (softEntry) {
    const current = readLru()[deckId]
    if (current && (current.ts || 0) > (softEntry.ts || 0)) return
  }
  const cache = await getCache()
  await cache.delete(CACHE_URL_PREFIX + deckId)
  const lru = readLru()
  delete lru[deckId]
  writeLru(lru)
}

/**
 * Build the recents list from the LRU map, but only include deckIds
 * that actually have a cached blob (drops orphans where Cache and LRU
 * disagree, e.g. user manually cleared site data).
 */
export async function listRecents(): Promise<RecentItem[]> {
  const lru = readLru()
  const ids = Object.keys(lru)
  if (ids.length === 0) return []
  const cache = await getCache()
  const checks = await Promise.all(
    ids.map(async (id) => {
      const has = await cache.match(CACHE_URL_PREFIX + id)
      return has ? id : null
    }),
  )
  return checks
    .filter((id): id is string => Boolean(id))
    .map((id) => ({ id, name: lru[id].name || '(unnamed)', ts: lru[id].ts || 0 }))
    .sort((a, b) => b.ts - a.ts)
}
