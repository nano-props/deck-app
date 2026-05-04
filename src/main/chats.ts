import type { AgentMessage } from '@mariozechner/pi-agent-core'
import type { Message } from '@mariozechner/pi-ai'
import { SessionManager } from '@mariozechner/pi-coding-agent'
import { app } from 'electron'
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'

/**
 * Chat transcript persistence for the Editor Agent.
 *
 * We delegate to pi-coding-agent's `SessionManager`, which owns the
 * append-only JSONL format (SessionEntry per line, with parent-child
 * linkage via entry ids). pi uses this format to power its compaction
 * pipeline (entries get a stable `firstKeptEntryId` that points at the
 * boundary of a summarized section). We piggy-back on that.
 *
 * Layout:
 *   userData/
 *     chats/
 *       <deckId>/                 ← one directory per deck
 *         <timestamp>_<sid>.jsonl ← one file per session (pi-managed)
 *
 * `deckId` is a SHA-256 prefix of the deck's canonical rootDir path. On
 * macOS/Windows the path is case-folded before hashing so symlink
 * renames don't split the identity.
 *
 * Opening a deck calls `openDeckSessionManager(rootDir)` which resumes
 * the most recent session in that directory, or starts a new one if
 * none exists. `resetDeckSessionManager(mgr)` deletes the current
 * session file and rolls over to a fresh one.
 *
 * Why delete instead of keep old files as a recovery breadcrumb: pi's
 * `newSession` only writes the new file's header when the next message
 * is actually appended — and pi *additionally* defers the first disk
 * flush until an assistant message arrives. If the user hits reset and
 * then closes the app before sending anything, the new file never
 * exists on disk and `findMostRecentSession` resurrects the old one
 * next time. Deleting makes reset mean reset.
 *
 * Retention for other cases (compaction rollovers, e.g. when pi
 * eventually exposes that): `SessionManager.getSessionFile()` and
 * `getSessionDir()` expose paths for a future background sweep.
 */

/** Canonicalize a rootDir path for hashing — case-fold on case-insensitive FS. */
function canonicalize(rootDir: string): string {
  const resolved = path.resolve(rootDir)
  const ci = process.platform === 'darwin' || process.platform === 'win32'
  return ci ? resolved.toLowerCase() : resolved
}

/** Stable id derived from the deck's rootDir. Used as the per-deck dir name. */
export function deckChatId(rootDir: string): string {
  return createHash('sha256').update(canonicalize(rootDir)).digest('hex').slice(0, 16)
}

function deckChatDir(rootDir: string): string {
  const dir = path.join(app.getPath('userData'), 'chats', deckChatId(rootDir))
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Open (or resume) the SessionManager for a deck. If the deck has a prior
 * session on disk, its messages are restored; otherwise a new session file
 * is started.
 *
 * `cwd` in pi-land is the working directory the session is associated
 * with. We pass the deck's rootDir so pi's session header records the
 * right origin — it's cosmetic for us (we never use it to route) but
 * keeps the session files self-describing.
 */
export function openDeckSessionManager(rootDir: string): SessionManager {
  const dir = deckChatDir(rootDir)
  return SessionManager.continueRecent(rootDir, dir)
}

/**
 * Start a fresh session. Deletes the current session file first so
 * `continueRecent` can't resurrect the old transcript (see module doc).
 * Safe no-ops: missing file / in-memory manager.
 */
export function resetDeckSessionManager(manager: SessionManager): void {
  const current = manager.getSessionFile()
  if (current) {
    try {
      rmSync(current, { force: true })
    } catch {
      // If we can't delete, the new session will still write alongside
      // the old one — `findMostRecentSession` will prefer the newer by
      // mtime once the new file is flushed. Not ideal but not fatal.
    }
  }
  manager.newSession()
}

/**
 * Extract the resumed message list from a freshly-opened SessionManager
 * — what `Agent.initialState.messages` should be seeded with.
 *
 * `manager.buildSessionContext()` applies any compaction entries by
 * emitting the summary message + the kept tail (we don't want to replay
 * the pre-summary history — that's the whole point of compaction). It
 * traverses from the leaf pi is tracking internally, which the
 * top-level `buildSessionContext(entries)` overload wouldn't know about.
 */
export function restoredMessages(manager: SessionManager): AgentMessage[] {
  return manager.buildSessionContext().messages
}

/**
 * Persist a run's messages in order. Called once per `agent_end` event,
 * which pi-agent-core emits with user prompt + assistant messages + tool
 * results. It never emits pi's synthetic BranchSummary / CompactionSummary
 * there (those are written by the SessionManager itself via
 * appendCompaction / appendBranchSummary), so the `as Message` narrowing
 * is safe.
 */
export function persistAgentMessages(manager: SessionManager, messages: AgentMessage[]): void {
  for (const m of messages) {
    manager.appendMessage(m as Message)
  }
}
