import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { Message } from '@earendil-works/pi-ai'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { app } from 'electron'
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { canonicalPath } from '#/main/util/path-identity.ts'

/**
 * Chat transcript persistence for the deck-bound Agent.
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
 * `deckId` is a SHA-256 prefix of the deck's canonical *sourcePath* —
 * the `.deck` file or Source directory the user opened. NOT the
 * `rootDir`, because for a Pack `rootDir` is a per-open tmpdir that
 * differs every time we extract — hashing that would split the same
 * deck's history across opens. On macOS/Windows the path is case-folded
 * before hashing so symlink renames don't split the identity.
 *
 * Functions take an explicit `chatKey` (= the deck's `sourcePath`) plus
 * a `rootDir` cwd that pi's SessionManager records in its header.
 * Two parameters because the chat dir is identity-keyed but pi's cwd
 * has to point at the live extracted directory for tool-use traces.
 *
 * Opening a deck calls `openDeckSessionManager(chatKey, rootDir)` which
 * resumes the most recent session in that directory, or starts a new
 * one if none exists. `resetDeckSessionManager(mgr)` deletes the
 * current session file and rolls over to a fresh one.
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

/** Stable id derived from the deck's source path (the user-facing identity). */
export function deckChatId(chatKey: string): string {
  return createHash('sha256').update(canonicalPath(chatKey)).digest('hex').slice(0, 16)
}

function deckChatDir(chatKey: string): string {
  const dir = path.join(app.getPath('userData'), 'chats', deckChatId(chatKey))
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Open (or resume) the SessionManager for a deck. If the deck has a prior
 * session on disk, its messages are restored; otherwise a new session file
 * is started.
 *
 * `chatKey` selects the chat directory (the deck's stable identity).
 * `rootDir` is the live extraction passed to pi as cwd — it shows up in
 * pi's session header so traces are self-describing.
 */
export function openDeckSessionManager(chatKey: string, rootDir: string): SessionManager {
  const dir = deckChatDir(chatKey)
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
 * Lightweight summary of one persisted chat session — the shape sent to
 * the renderer for the History popover. Derived from pi's `SessionInfo`
 * but trimmed to the fields the UI actually shows.
 */
export interface DeckChatSummary {
  /** Absolute path to the session's .jsonl file. Used as the stable id
   *  for switch/delete IPCs (sessionId would also work but path is what
   *  pi.SessionManager.open() takes directly). */
  path: string
  /** Short text from the first user message, '' if the session is empty.
   *  Renderer treats '' as "skip / hide". */
  firstMessage: string
  /** Number of message-shaped entries — used as a "msgs" badge. */
  messageCount: number
  /** Last-modified timestamp in ms, for relative-time labels. */
  modifiedMs: number
}

/**
 * List every chat session for a deck, newest first. Empty sessions
 * (no first message yet) are filtered out — they exist on disk for users
 * who hit "new chat" and then closed without typing, but they're not
 * useful in a switcher.
 */
export async function listDeckChatSessions(chatKey: string, rootDir: string): Promise<DeckChatSummary[]> {
  const dir = deckChatDir(chatKey)
  const all = await SessionManager.list(rootDir, dir)
  return all
    .filter((s) => typeof s.firstMessage === 'string' && s.firstMessage.trim().length > 0)
    .map((s) => ({
      path: s.path,
      firstMessage: s.firstMessage,
      messageCount: s.messageCount,
      modifiedMs: s.modified.getTime(),
    }))
}

/**
 * Defence-in-depth check: a sessionPath supplied by the renderer must
 * resolve inside the deck's own chat directory. The renderer is
 * untrusted code (XSS in deck content could reach the chrome via a
 * compromised contextBridge); a path here that escapes the chat dir
 * would let an attacker call `SessionManager.open` on / `rmSync` any
 * file the main process can read/write.
 *
 * Returns true when `sessionPath` is safe; false otherwise. Caller is
 * expected to bail (no-op or error) on `false`.
 */
function isPathInside(sessionPath: string, dir: string): boolean {
  const resolvedPath = path.resolve(sessionPath)
  const resolvedDir = path.resolve(dir) + path.sep
  return resolvedPath.startsWith(resolvedDir)
}

/**
 * Open a SessionManager pointing at a specific session file. Used when
 * the user picks a past session in the History popover.
 *
 * Mirrors `openDeckSessionManager` but bypasses `continueRecent`'s
 * "most-recent" selection. Throws if `sessionPath` escapes the deck's
 * chat directory (renderer-supplied input is not trusted — see
 * `isPathInside`).
 */
export function openDeckChatSession(
  chatKey: string,
  rootDir: string,
  sessionPath: string,
): SessionManager {
  const dir = deckChatDir(chatKey)
  if (!isPathInside(sessionPath, dir)) {
    throw new Error('sessionPath escapes deck chat directory')
  }
  return SessionManager.open(sessionPath, dir, rootDir)
}

/**
 * Delete a single session file. Best-effort — a held-open file (current
 * SessionManager) returns an error on Windows; caller should close the
 * SessionManager first if deleting the active session.
 *
 * `chatKey` is required so we can scope the delete to the deck's own
 * chat directory. A path outside that dir is rejected; this is
 * defence-in-depth on top of the IPC handler's own validation.
 *
 * Returns true on success (or if the file was already gone), false on
 * path-escape rejection or unlink failure — the renderer's history
 * popover uses the boolean to decide whether to remove the row from
 * its UI optimistically.
 */
export function deleteChatSession(chatKey: string, sessionPath: string): boolean {
  const dir = deckChatDir(chatKey)
  if (!isPathInside(sessionPath, dir)) return false
  try {
    rmSync(sessionPath, { force: true })
    return true
  } catch {
    return false
  }
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
