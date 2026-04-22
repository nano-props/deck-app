import AdmZip from 'adm-zip'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { DeckManifest, LoadedDeck } from '#/main/deck-types.ts'

/** Wall-clock time this process started, used to identify stale temp dirs. */
const PROCESS_START_MS = Date.now()

export class DeckLoadError extends Error {}

const TMP_NAMESPACE = 'deck-app'

export function tempNamespaceDir(): string {
  return path.join(tmpdir(), TMP_NAMESPACE)
}

/**
 * Load a deck from disk. Accepts either a `.deck` (zip) file — which is
 * extracted into a temp directory — or an already-unpacked directory
 * (treated as-is; the caller does not own it).
 */
export async function loadDeck(deckPath: string): Promise<LoadedDeck> {
  if (!existsSync(deckPath)) {
    throw new DeckLoadError(`Not found: ${deckPath}`)
  }
  const info = await stat(deckPath)
  if (info.isDirectory()) {
    return loadDeckFromDir(deckPath)
  }
  return loadDeckFromFile(deckPath)
}

async function loadDeckFromFile(deckPath: string): Promise<LoadedDeck> {
  const rootDir = path.join(tempNamespaceDir(), randomUUID())
  await mkdir(rootDir, { recursive: true })

  try {
    extractZipSafely(deckPath, rootDir)
    const manifest = await validateDeckRoot(rootDir)
    return { rootDir, manifest, ownsRootDir: true }
  } catch (err) {
    // Clean up the half-extracted directory on failure.
    await rm(rootDir, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}

async function loadDeckFromDir(dirPath: string): Promise<LoadedDeck> {
  const rootDir = path.resolve(dirPath)
  const manifest = await validateDeckRoot(rootDir)
  return { rootDir, manifest, ownsRootDir: false }
}

async function validateDeckRoot(rootDir: string): Promise<DeckManifest> {
  const manifestPath = path.join(rootDir, 'deck.json')
  if (!existsSync(manifestPath)) {
    throw new DeckLoadError('Missing deck.json in the root of the deck')
  }

  const raw = await readFile(manifestPath, 'utf8')
  let manifest: DeckManifest
  try {
    manifest = JSON.parse(raw) as DeckManifest
  } catch (err) {
    throw new DeckLoadError(`deck.json is not valid JSON: ${(err as Error).message}`)
  }

  if (!manifest.name || typeof manifest.name !== 'string') {
    throw new DeckLoadError('deck.json is missing required field "name"')
  }

  const indexPath = path.join(rootDir, 'index.html')
  if (!existsSync(indexPath)) {
    throw new DeckLoadError('Missing index.html in the root of the deck')
  }

  return manifest
}

/**
 * Extract the zip while rejecting entries with absolute paths or `..`
 * segments (Zip Slip). adm-zip's extractAllTo does not guarantee this
 * on all versions, so we iterate and check each entry ourselves.
 */
function extractZipSafely(zipPath: string, destDir: string): void {
  const zip = new AdmZip(zipPath)
  const resolvedDest = path.resolve(destDir)

  for (const entry of zip.getEntries()) {
    const entryName = entry.entryName.replace(/\\/g, '/')

    if (entryName.startsWith('/') || /^[A-Za-z]:/.test(entryName)) {
      throw new DeckLoadError(`Refusing absolute path in zip: ${entryName}`)
    }
    if (entryName.split('/').some((seg) => seg === '..')) {
      throw new DeckLoadError(`Refusing path traversal in zip: ${entryName}`)
    }

    const targetPath = path.resolve(destDir, entryName)
    if (!targetPath.startsWith(resolvedDest + path.sep) && targetPath !== resolvedDest) {
      throw new DeckLoadError(`Zip entry escapes destination: ${entryName}`)
    }
  }

  zip.extractAllTo(destDir, /* overwrite */ true)
}

/**
 * Sweep leftover extracted decks from previous sessions that did not
 * shut down cleanly. Called once at app startup, before this process
 * extracts any new decks.
 *
 * Safety: we only delete subdirs whose mtime is not *after* this
 * process's start time. Using `<=` (rather than `<`) catches stale
 * dirs whose mtime happens to round to the same second as our start,
 * which matters on filesystems with whole-second mtime resolution
 * (HFS+, some Linux configurations). A hypothetical sibling process
 * extracting concurrently would have mtime strictly greater than our
 * start (it began after us) and is excluded. The single-instance lock
 * normally prevents siblings entirely; this is defense in depth.
 */
export async function sweepStaleTempDirs(): Promise<void> {
  const ns = tempNamespaceDir()
  if (!existsSync(ns)) return

  let entries: string[]
  try {
    entries = await readdir(ns)
  } catch {
    return
  }

  await Promise.all(
    entries.map(async (name) => {
      const p = path.join(ns, name)
      try {
        const s = await stat(p)
        if (s.mtimeMs <= PROCESS_START_MS) {
          await rm(p, { recursive: true, force: true })
        }
      } catch {
        // ignore — the entry may have been removed by another process
      }
    }),
  )
}
