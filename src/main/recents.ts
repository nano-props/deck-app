import { app } from 'electron'
import { existsSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathsEqual } from '#/main/util/path-identity.ts'

/**
 * MRU list of recently opened decks, persisted to `userData/recents.json`.
 *
 * Entries are stored as the raw path the user opened (.deck file or
 * directory). On rehydrate we filter out any that no longer exist.
 */

export interface RecentEntry {
  /** The path the user opened — `.deck` file or Deck Source directory. */
  path: string
  /** Deck name from manifest at the time it was opened; purely cosmetic. */
  name: string
  /** Epoch ms of last open — used to sort. */
  openedAt: number
}

const MAX_RECENTS = 10

function recentsFile(): string {
  return path.join(app.getPath('userData'), 'recents.json')
}

async function readRaw(): Promise<RecentEntry[]> {
  const file = recentsFile()
  if (!existsSync(file)) return []
  try {
    const raw = await readFile(file, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (e): e is RecentEntry =>
        !!e &&
        typeof e === 'object' &&
        typeof (e as RecentEntry).path === 'string' &&
        typeof (e as RecentEntry).name === 'string' &&
        typeof (e as RecentEntry).openedAt === 'number',
    )
  } catch {
    return []
  }
}

async function writeAtomic(data: RecentEntry[]): Promise<void> {
  const file = recentsFile()
  const tmp = file + '.tmp'
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await rename(tmp, file)
}

/**
 * Tail of the read-modify-write queue. Recents need the *whole* RMW
 * cycle serialized, not just the disk write — two concurrent recordOpen
 * calls would each read the old list, splice their own entry, and the
 * second writer overwrites the first's contribution. Chaining onto this
 * tail forces a strict happens-before ordering across recordOpen,
 * forgetRecent, and the prune-on-list path.
 *
 * Errors don't sink the chain — each task's catch keeps the tail
 * resolvable so one failure doesn't poison subsequent calls.
 */
let queue: Promise<unknown> = Promise.resolve()

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn)
  queue = next.catch(() => {})
  return next
}

/**
 * Return the MRU list, newest first, with stale entries (whose paths no
 * longer exist on disk) pruned.
 */
export function listRecents(): Promise<RecentEntry[]> {
  return enqueue(async () => {
    const all = await readRaw()
    const live = all.filter((e) => existsSync(e.path))
    // If we pruned anything, persist the clean list (best-effort).
    if (live.length !== all.length) await writeAtomic(live).catch(() => {})
    return live.sort((a, b) => b.openedAt - a.openedAt).slice(0, MAX_RECENTS)
  })
}

/**
 * Record an open. If the path already exists, its timestamp is bumped
 * (and name refreshed if changed); otherwise it's prepended.
 */
export function recordOpen(entry: { path: string; name: string }): Promise<void> {
  return enqueue(async () => {
    const resolved = path.resolve(entry.path)
    const current = await readRaw()
    const existing = current.findIndex((e) => pathsEqual(e.path, resolved))
    const next: RecentEntry = { path: resolved, name: entry.name, openedAt: Date.now() }
    const list = existing >= 0 ? [next, ...current.filter((_, i) => i !== existing)] : [next, ...current]
    await writeAtomic(list.slice(0, MAX_RECENTS))
  })
}

/** Remove a single recent by path. */
export function forgetRecent(p: string): Promise<void> {
  return enqueue(async () => {
    const current = await readRaw()
    const filtered = current.filter((e) => !pathsEqual(e.path, p))
    if (filtered.length !== current.length) await writeAtomic(filtered)
  })
}
