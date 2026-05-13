import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { Message } from '@earendil-works/pi-ai'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { app } from 'electron'
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { canonicalPath } from '#/main/util/path-identity.ts'

/**
 * pi-agent transcript helpers, scoped to one deck.
 *
 * The per-deck *chat directory* lives at
 *   `userData/chats/<deckId>/`
 * and holds two kinds of files:
 *   - `<timestamp>_<sid>.jsonl` — pi-coding-agent's own append-only
 *     transcript. Created by `SessionManager.continueRecent` /
 *     `SessionManager.open` (see ai/session/index.ts). One per
 *     successful pi-agent deck-session.
 *   - `meta/<deckSessionUuid>.json` — deck-level session metadata
 *     (see ai/session-store.ts). The single source of truth for
 *     "what conversations exist for this deck"; the .jsonl files
 *     above are pointed to from each metadata record's
 *     `providerSessionId`.
 *
 * `deckId` is a SHA-256 prefix of the deck's canonical *sourcePath* —
 * the `.deck` file or Source directory the user opened. NOT the
 * `rootDir`, because for a Pack `rootDir` is a per-open tmpdir that
 * differs every time we extract — hashing that would split the same
 * deck's history across opens. On macOS/Windows the path is case-folded
 * before hashing so symlink renames don't split the identity.
 *
 * Functions here are the small surface that ai/session/index.ts and
 * ipc/ai.ts still need: deckChatId / deckChatDir for path derivation,
 * openDeckChatSession to load a specific pi JSONL, deleteChatSession
 * to clean one up, and the persist/restore helpers used inside the
 * pi-agent backend's send loop.
 */

/** Stable id derived from the deck's source path (the user-facing identity). */
export function deckChatId(chatKey: string): string {
  return createHash('sha256').update(canonicalPath(chatKey)).digest('hex').slice(0, 16)
}

export function deckChatDir(chatKey: string): string {
  const dir = path.join(app.getPath('userData'), 'chats', deckChatId(chatKey))
  mkdirSync(dir, { recursive: true })
  return dir
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
 * Open a SessionManager pointing at a specific session file. Used by
 * the pi-agent backend when a deck-session record's
 * `providerSessionId` points at an existing pi JSONL (history switch
 * or resume across launches). Throws if `sessionPath` escapes the
 * deck's chat directory — record fields originate on disk, but a
 * compromised renderer could in principle plant one, so this stays
 * as a defence-in-depth check.
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
