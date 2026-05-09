import AdmZip from 'adm-zip'
import { readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'

/**
 * Pack a Deck Source directory into a `.deck` (zip). The output is a plain
 * zip with the Deck Source's contents at the root — so a consumer that
 * extracts the zip gets `deck.json` and `index.html` directly, not nested
 * under `<deck-name>/`.
 *
 * Skipped patterns (see `SKIP_NAMES` / `SKIP_EXT`) keep the pack small and
 * reproducible — OS litter (`.DS_Store`, `Thumbs.db`), version control,
 * editor scratch, and our own temp/backup files never ship.
 */

export class DeckPackError extends Error {}

// Exact basenames we never ship.
const SKIP_NAMES = new Set([
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  '.git',
  '.gitignore',
  '.gitattributes',
  '.svn',
  '.hg',
  'node_modules',
  '.idea',
  '.vscode',
  '__pycache__',
])
// Extensions we never ship.
const SKIP_EXT = new Set(['.swp', '.swo', '.tmp', '.log'])

function shouldSkip(name: string): boolean {
  if (SKIP_NAMES.has(name)) return true
  // Drop editor backup files like `index.html~` and `.#foo`.
  if (name.endsWith('~')) return true
  if (name.startsWith('.#')) return true
  const ext = path.extname(name).toLowerCase()
  if (SKIP_EXT.has(ext)) return true
  return false
}

async function collectEntries(rootDir: string): Promise<{ absPath: string; relPosixPath: string }[]> {
  const out: { absPath: string; relPosixPath: string }[] = []
  // Track real (post-realpath) directory paths we've already walked so a
  // symlink loop — `<root>/sub/back-to-root → <root>` is the canonical
  // example, but git submodules and some build outputs can produce
  // similar shapes — terminates instead of recursing forever. Files
  // don't need this; only directory recursion can loop.
  const visitedDirs = new Set<string>()

  async function walk(dirAbs: string, relPosix: string): Promise<void> {
    let dirReal: string
    try {
      dirReal = await realpath(dirAbs)
    } catch {
      return
    }
    if (visitedDirs.has(dirReal)) return
    visitedDirs.add(dirReal)

    const entries = await readdir(dirAbs, { withFileTypes: true })
    for (const entry of entries) {
      if (shouldSkip(entry.name)) continue
      const absPath = path.join(dirAbs, entry.name)
      // Zip entries are POSIX-separated by spec; `path.posix.join` keeps
      // that consistent even when we're packing on Windows.
      const childRel = relPosix ? path.posix.join(relPosix, entry.name) : entry.name

      if (entry.isSymbolicLink()) {
        // Symlinks are risky: they can silently expand the pack or point
        // outside the Deck Source. Resolve the target, verify it's still
        // inside rootDir, then follow — otherwise skip.
        let realTarget: string
        try {
          realTarget = await realpath(absPath)
        } catch {
          continue
        }
        const resolvedRoot = path.resolve(rootDir)
        if (!realTarget.startsWith(resolvedRoot + path.sep) && realTarget !== resolvedRoot) {
          continue
        }
        let targetStat: Awaited<ReturnType<typeof stat>>
        try {
          targetStat = await stat(absPath)
        } catch {
          continue
        }
        if (targetStat.isDirectory()) {
          await walk(absPath, childRel)
        } else if (targetStat.isFile()) {
          out.push({ absPath, relPosixPath: childRel })
        }
        continue
      }

      if (entry.isDirectory()) {
        await walk(absPath, childRel)
      } else if (entry.isFile()) {
        out.push({ absPath, relPosixPath: childRel })
      }
      // Other types (sockets, block devices, …) — ignore.
    }
  }

  await walk(rootDir, '')
  return out
}

/**
 * Validate that the directory looks like a Deck Source (has `deck.json`
 * and `index.html` at the root). Doesn't parse the manifest — we let a
 * bad manifest through so the user can still pack a broken state for
 * debugging. The Player is the one who will surface the parse error.
 */
async function requireDeckShape(rootDir: string): Promise<void> {
  const entries = await readdir(rootDir).catch(() => [] as string[])
  const has = (name: string) => entries.includes(name)
  if (!has('deck.json')) throw new DeckPackError('Missing deck.json at the Deck Source root.')
  if (!has('index.html')) throw new DeckPackError('Missing index.html at the Deck Source root.')
}

export interface PackResult {
  destPath: string
  fileCount: number
  bytes: number
}

/**
 * Zip `rootDir` into `destPath`. Caller chose the path (via save dialog)
 * and is responsible for surfacing success. Overwrites `destPath` if it
 * already exists — `dialog.showSaveDialog` has already asked for
 * confirmation by that point.
 */
export async function packDeck(rootDir: string, destPath: string): Promise<PackResult> {
  await requireDeckShape(rootDir)

  const entries = await collectEntries(rootDir)
  if (entries.length === 0) {
    throw new DeckPackError('Deck Source is empty — nothing to pack.')
  }

  const zip = new AdmZip()
  for (const { absPath, relPosixPath } of entries) {
    // `addLocalFile(filePath, zipPath)` — zipPath is the folder inside the
    // zip, so we split the rel path back into folder + basename.
    const folder = path.posix.dirname(relPosixPath)
    const basename = path.posix.basename(relPosixPath)
    zip.addLocalFile(absPath, folder === '.' ? '' : folder, basename)
  }

  // adm-zip writes the zip incrementally to disk — a mid-write failure
  // (disk full, IO error) would leave a truncated/corrupt file at
  // destPath, replacing whatever the user originally had there. Stage
  // to a sibling `.tmp` and rename on success so destPath only ever
  // moves between two complete-and-valid states.
  const tmpPath = destPath + '.tmp'
  try {
    await zip.writeZipPromise(tmpPath, { overwrite: true })
    await rename(tmpPath, destPath)
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {})
    throw err
  }

  const { size } = await stat(destPath)
  return { destPath, fileCount: entries.length, bytes: size }
}
