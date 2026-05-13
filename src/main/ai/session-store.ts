import { app } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { deckChatId } from '#/main/chats.ts'
import { KNOWN_PROVIDERS, type ProviderId } from '#/main/secrets.ts'

/**
 * Deck-level session store.
 *
 * The unit of conversation is the *deck session*, not the backend
 * session. A deck session has its own uuid, lives in
 *   `userData/chats/<deckId>/meta/<deckSessionUuid>.json`,
 * and records which AI provider it locked itself to at creation time
 * plus an optional pointer (`providerSessionId`) that the backend
 * adapter uses to resume its own state:
 *
 *   - For pi-agent backends (anthropic/openai/google/custom-*),
 *     `providerSessionId` is the path to pi-coding-agent's JSONL file
 *     under the same `<deckId>/` directory. pi controls the filename;
 *     we store its absolute path verbatim.
 *
 *   - For Claude Code (claude-cli), it's the CLI's own session uuid
 *     (used with `--resume`). The transcript itself lives under
 *     `~/.claude/projects/...` — outside our control — so the deck
 *     session is the only source of truth for "what did we talk about
 *     in this conversation".
 *
 * Provider lock: a deck session keeps the provider it was created
 * with. The active settings.ai.provider is just the default for *new*
 * sessions; switching it does NOT silently rebind an existing session.
 * The IPC layer enforces this by emitting deck:fatal with a friendly
 * "start a new chat" hint when the user tries to send into a session
 * whose provider no longer matches their settings.
 *
 * Failure mode: every operation here is best-effort. A failed read
 * means the session list shows stale entries; a failed write means we
 * lose the resume hint for that turn. We log warnings but never throw
 * upward — session creation must not break because of a flaky write.
 */

/** What we store per deck session. The shape is forward-compatible —
 *  unknown fields are preserved on disk via JSON round-trip. */
export interface DeckSessionRecord {
  /** Stable uuid for the deck session. Doubles as the metadata
   *  filename (`<id>.json`). Survives provider migrations / file
   *  renames — used as the popover row key on the renderer side. */
  id: string
  /** AI provider this session is locked to. Captured at creation. */
  provider: ProviderId
  /** ms since epoch — when the session was first created. */
  createdMs: number
  /** ms since epoch — last time a turn ran successfully. Drives
   *  popover ordering ("most recent first") and "open the deck →
   *  resume the most recent" behavior. */
  lastUsedMs: number
  /** Backend-specific pointer the adapter uses to resume:
   *   - pi-agent: absolute path to its .jsonl file (under deckChatDir)
   *   - claude-cli: the CLI's --session-id uuid
   *  Null when the session has no successful turns yet. */
  providerSessionId: string | null
  /** Cached preview of the first user message. Updated when a session
   *  gets its first turn so the popover has something to show without
   *  having to read the backend's transcript. Empty string for empty
   *  sessions (we hide those from the popover). */
  summary: string
}

function metaDir(chatKey: string): string {
  return path.join(app.getPath('userData'), 'chats', deckChatId(chatKey), 'meta')
}

/** UUID v4 / v7 shape. We mint via `crypto.randomUUID()` on session
 *  creation, so any id reaching us from disk or from renderer-supplied
 *  IPC arguments must match this — otherwise it's either corrupted
 *  state or a path-traversal attempt (`../../etc/passwd`). */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isValidSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id)
}

function metaFile(chatKey: string, sessionId: string): string {
  if (!isValidSessionId(sessionId)) {
    // Reject path-traversal attempts and accidental garbage. Callers
    // are expected to surface a benign failure to the user.
    throw new Error(`Invalid session id: ${sessionId}`)
  }
  return path.join(metaDir(chatKey), `${sessionId}.json`)
}

async function ensureMetaDir(chatKey: string): Promise<string> {
  const dir = metaDir(chatKey)
  await mkdir(dir, { recursive: true })
  return dir
}

/** Truncate / sanitize the first user message for `summary`. We trim
 *  control chars and collapse whitespace so a multi-line paste shows
 *  as one preview line. 100 chars is enough for a popover row. */
export function deriveSummary(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
}

/** Create a new deck session record bound to `provider`. Doesn't write
 *  to disk — the caller writes via `saveSession` once the first turn
 *  has produced a `providerSessionId` worth persisting. Empty sessions
 *  are deliberately not stored: a user who hits New Chat then closes
 *  without typing should not leave debris. */
export function newSessionRecord(provider: ProviderId): DeckSessionRecord {
  const now = Date.now()
  return {
    id: randomUUID(),
    provider,
    createdMs: now,
    lastUsedMs: now,
    providerSessionId: null,
    summary: '',
  }
}

/** Read every deck session for `chatKey`, newest first. Empty sessions
 *  (no successful turn yet) are filtered out — they exist only as
 *  in-memory drafts before the first `saveSession`. */
export async function listSessions(chatKey: string): Promise<DeckSessionRecord[]> {
  const dir = metaDir(chatKey)
  if (!existsSync(dir)) return []
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const records: DeckSessionRecord[] = []
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    const rec = await readSession(chatKey, name.slice(0, -'.json'.length))
    if (rec) records.push(rec)
  }
  records.sort((a, b) => b.lastUsedMs - a.lastUsedMs)
  return records
}

/** Pick the session to resume on deck open: the most-recently-used
 *  one. Returns null when the deck has never had a chat. */
export async function mostRecentSession(chatKey: string): Promise<DeckSessionRecord | null> {
  const all = await listSessions(chatKey)
  return all[0] ?? null
}

export async function readSession(chatKey: string, sessionId: string): Promise<DeckSessionRecord | null> {
  let file: string
  try {
    file = metaFile(chatKey, sessionId)
  } catch {
    return null
  }
  if (!existsSync(file)) return null
  try {
    const raw = await readFile(file, 'utf8')
    const parsed = JSON.parse(raw) as Partial<DeckSessionRecord>
    if (
      typeof parsed.id !== 'string' ||
      typeof parsed.provider !== 'string' ||
      !(KNOWN_PROVIDERS as readonly string[]).includes(parsed.provider) ||
      typeof parsed.createdMs !== 'number' ||
      typeof parsed.lastUsedMs !== 'number'
    ) {
      return null
    }
    return {
      id: parsed.id,
      provider: parsed.provider as ProviderId,
      createdMs: parsed.createdMs,
      lastUsedMs: parsed.lastUsedMs,
      providerSessionId:
        typeof parsed.providerSessionId === 'string' && parsed.providerSessionId.length > 0
          ? parsed.providerSessionId
          : null,
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    }
  } catch (e) {
    console.warn('[session-store] failed to read', file, e)
    return null
  }
}

/** Atomic write via tmp + rename. Best-effort — a failed write only
 *  loses the on-disk hint for this session. */
export async function saveSession(chatKey: string, record: DeckSessionRecord): Promise<void> {
  try {
    await ensureMetaDir(chatKey)
    const file = metaFile(chatKey, record.id)
    const tmp = file + '.tmp'
    await writeFile(tmp, JSON.stringify(record, null, 2), 'utf8')
    await rename(tmp, file)
  } catch (e) {
    console.warn('[session-store] failed to save session', record.id, e)
  }
}

/** Delete the metadata file. The caller is responsible for cleaning up
 *  the backend's transcript (pi's jsonl, Claude's project file) — we
 *  don't reach into either backend's storage from here. */
export async function deleteSession(chatKey: string, sessionId: string): Promise<boolean> {
  let file: string
  try {
    file = metaFile(chatKey, sessionId)
  } catch {
    return false
  }
  if (!existsSync(file)) return true
  try {
    await unlink(file)
    return true
  } catch (e) {
    console.warn('[session-store] failed to delete', file, e)
    return false
  }
}
