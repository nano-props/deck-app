import { homedir } from 'node:os'
import { delimiter } from 'node:path'

/**
 * Augment PATH with directories where `claude` is commonly installed but
 * which the GUI app's environment doesn't include.
 *
 * Background: when Electron is launched from Finder / Dock / `open` (i.e.
 * the packaged app the user actually runs), macOS gives the process a
 * minimal PATH — typically just `/usr/bin:/bin:/usr/sbin:/sbin` — set by
 * launchd from `/etc/paths`. None of the locations Claude Code installs
 * itself into are on that list.
 *
 * Candidate list — best-effort, not exhaustive. Claude Code's official
 * docs only publish install commands, not destinations, so these are
 * inferred from the install mechanisms themselves:
 *   - `~/.local/bin`                       (XDG user-local; the curl
 *                                           installer at claude.ai/install.sh
 *                                           is widely reported to use it)
 *   - `/opt/homebrew/bin`, `/usr/local/bin` (Homebrew on Apple Silicon /
 *                                           Intel; also where `npm i -g`
 *                                           lands when Node was itself
 *                                           installed via Homebrew, since
 *                                           npm symlinks into
 *                                           `$(npm prefix -g)/bin`)
 *   - `~/.bun/bin`                         (bun global install)
 *
 * Users on nvm/n/volta with a non-Homebrew Node prefix and `npm i -g`
 * installs land outside this list. Acceptable for v1 — they can fall
 * back to Homebrew or the curl installer; we surface "not found in
 * common install locations" so the message is honest about the gap.
 *
 * In `bun dev` this function is a no-op: the dev parent is the user's
 * interactive shell, which already exported a full PATH from `.zshrc`,
 * so the dedupe Set below filters every candidate. The fix only matters
 * for the packaged app launched via Finder/Dock.
 *
 * We deliberately do NOT shell through `bash -lc` to source the user's
 * rc files: that path picks up shell aliases (the user's `claude` may
 * actually be `AWS_PROFILE=… ENABLE_TOOL_SEARCH=true claude`), which
 * silently re-shapes how we invoke the CLI. Augmenting PATH with the
 * known install locations is narrower and predictable.
 *
 * macOS-only: the candidate paths and the launchd-PATH problem are both
 * Apple-specific. The Deck App ships only for macOS today; if that ever
 * changes, this list needs platform branches.
 */
export function enhancedPath(): string {
  const home = homedir()
  const candidates = [
    `${home}/.local/bin`,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    `${home}/.bun/bin`,
  ]
  const current = process.env.PATH ?? ''
  const existing = new Set(current.split(delimiter).filter(Boolean))
  const additions = candidates.filter((p) => !existing.has(p))
  if (additions.length === 0) return current
  return current ? `${current}${delimiter}${additions.join(delimiter)}` : additions.join(delimiter)
}
