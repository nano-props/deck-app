import { app } from 'electron'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'

/**
 * Edit-mode workspaces for Deck Packs.
 *
 * When the user opens a `.deck` Pack and switches to Edit, we can't write
 * into the zip. Previously we unpacked to a sibling directory and made the
 * user pick a path when one already existed — clunky. Now the unpack
 * destination is app-managed: `userData/workspaces/<slug>-<hash12>/`.
 *
 * The hash is SHA-256 of the Pack's bytes, so opening the same Pack twice
 * resolves to the same workspace. This preserves the user's edits across
 * sessions: Edit → Close → Edit again picks up where they left off.
 *
 * Workspaces are NOT auto-deleted on close (unlike the play-mode temp
 * extraction). A stale/orphan workspace stays until the user clears it
 * via "Open Workspaces Folder" in the File menu.
 */

const WORKSPACES_DIRNAME = 'workspaces'

export function workspacesRoot(): string {
  return path.join(app.getPath('userData'), WORKSPACES_DIRNAME)
}

/**
 * URL-safe slug derived from a deck name. Purely cosmetic — the hash is
 * what disambiguates. Falls back to "deck" if the name contains nothing
 * we can keep.
 */
function slugify(name: string): string {
  const cleaned = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32)
  return cleaned || 'deck'
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve())
    stream.on('error', reject)
  })
  return hash.digest('hex')
}

export interface WorkspaceResolution {
  /** Absolute path to the workspace dir (may or may not exist yet). */
  dir: string
  /**
   * - 'fresh':    dir doesn't exist — caller should unpack into it.
   * - 'reusable': dir exists and looks like a valid Deck Source — caller
   *                can reuse as-is, or offer the user a chance to reset.
   * - 'broken':   dir exists but isn't a valid Deck Source — caller
   *                should clear and re-unpack without prompting (nothing
   *                useful to preserve).
   */
  state: 'fresh' | 'reusable' | 'broken'
}

/**
 * Locate (don't create) the workspace that would back editing `zipPath`.
 * Deck name is used only for the slug portion of the directory; the hash
 * is the identity. Callers pass a friendly name if they have one cached.
 */
export async function resolveWorkspaceForPack(
  zipPath: string,
  deckName: string | undefined,
): Promise<WorkspaceResolution> {
  const hash = await hashFile(zipPath)
  const slug = slugify(deckName || path.parse(zipPath).name)
  const dir = path.join(workspacesRoot(), `${slug}-${hash.slice(0, 12)}`)

  if (!existsSync(dir)) return { dir, state: 'fresh' }
  const manifest = path.join(dir, 'deck.json')
  const index = path.join(dir, 'index.html')
  if (existsSync(manifest) && existsSync(index)) return { dir, state: 'reusable' }
  return { dir, state: 'broken' }
}

/**
 * Remove a workspace's contents (but not the directory itself, so the
 * caller can unpack into it without a redundant mkdir race).
 */
export async function clearWorkspace(dir: string): Promise<void> {
  const entries = await readdir(dir).catch(() => [] as string[])
  await Promise.all(entries.map((name) => rm(path.join(dir, name), { recursive: true, force: true })))
}

/** Ensure the workspace directory (and the workspaces root) exist. */
export async function ensureWorkspaceDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}
