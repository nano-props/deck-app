import { app } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { deckChatId } from '#/main/chats.ts'
import type { DeckKind } from '#/main/deck-types.ts'
import { decideResumeStrategy } from '#/main/ai/resume-strategy.ts'
import { isCliProvider, KNOWN_PROVIDERS, type ProviderId } from '#/main/secrets.ts'

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

/** Fields shared by every deck session record, regardless of state. */
interface DeckSessionRecordBase {
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
}

/** A session that has never persisted a successful turn. Lives only in
 *  memory until the first turn lands; the popover hides it because it
 *  has no `summary` to display. */
export interface DraftSessionRecord extends DeckSessionRecordBase {
  kind: 'draft'
}

/** A session that has produced at least one successful turn. Carries
 *  the backend's resume hint and a cached first-message summary so the
 *  history popover can render the row without reading the transcript. */
export interface ActiveSessionRecord extends DeckSessionRecordBase {
  kind: 'active'
  /** Backend-specific pointer the adapter uses to resume:
   *   - pi-agent: absolute path to its .jsonl file (under deckChatDir)
   *   - claude-cli: the CLI's --session-id uuid
   *  Always non-null on `kind:'active'` — the type system enforces the
   *  invariant that "active means resumable" (which used to be an
   *  implicit relationship between `summary` and `providerSessionId`). */
  providerSessionId: string
  /** Cached preview of the first user message. Non-empty by
   *  construction on `kind:'active'`. */
  summary: string
}

/** What we store per deck session. The shape is forward-compatible —
 *  unknown fields are preserved on disk via JSON round-trip. The
 *  discriminated union over `kind` makes the draft → active transition
 *  type-safe: callers can't accidentally read `providerSessionId` /
 *  `summary` from a draft, and the persistence layer knows it should
 *  only write to disk once `kind === 'active'`. */
export type DeckSessionRecord = DraftSessionRecord | ActiveSessionRecord

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

/** Validate `providerSessionId` against what the bound backend expects.
 *  Returns null for missing/invalid values so the caller treats the
 *  record as "no resume hint" rather than passing tampered content
 *  into a CLI flag or file path. */
function validProviderSessionId(provider: ProviderId, raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  if (isCliProvider(provider)) {
    return SESSION_ID_RE.test(raw) ? raw : null
  }
  // pi-agent stores an absolute path. chats.ts is the real safety
  // boundary (deleteChatSession does an `isPathInside(deckChatDir)`
  // check before unlink), but reject obvious garbage here so a
  // tampered metadata file with `"../../etc/passwd"` style content
  // never even reaches that gate. Require absolute + no control
  // chars; canonicalization stays at the use site.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(raw)) return null
  if (!path.isAbsolute(raw)) return null
  return raw
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
export function newSessionRecord(provider: ProviderId): DraftSessionRecord {
  const now = Date.now()
  return {
    kind: 'draft',
    id: randomUUID(),
    provider,
    createdMs: now,
    lastUsedMs: now,
  }
}

/** Promote a draft to active in place. Returns a new object — never
 *  mutates the draft (callers may still hold the draft reference). */
export function promoteToActive(
  draft: DraftSessionRecord,
  providerSessionId: string,
  summary: string,
): ActiveSessionRecord {
  return {
    kind: 'active',
    id: draft.id,
    provider: draft.provider,
    createdMs: draft.createdMs,
    lastUsedMs: Date.now(),
    providerSessionId,
    summary,
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
 *  one whose resume key still survives a reopen. Returns null when
 *  the deck has never had a chat or the only chats it has are stale
 *  (Pack+CLI records carried over from an older app version that
 *  point to unreachable tmpdir-keyed transcripts).
 *
 *  Skipping unrecoverable records here matters because otherwise
 *  `ensure()` would resume an old Pack+CLI row, mint a fresh uuid
 *  internally, and leave the user staring at a session that looks
 *  like it should have history but actually has none. Better to
 *  start a brand-new chat. */
export async function mostRecentSession(
  chatKey: string,
  deckKind: DeckKind,
): Promise<DeckSessionRecord | null> {
  const all = await listSessions(chatKey)
  for (const r of all) {
    if (decideResumeStrategy(r, deckKind).resumeSurvivesReopen) return r
  }
  return null
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
    // On-disk format pre-discriminated-union didn't have a `kind`
    // field — we infer it from the presence/validity of the resume
    // hint + summary. New writes always include `kind` (see
    // `saveSession`), so going forward this is just a forward-compat
    // path for older record files.
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (
      typeof parsed.id !== 'string' ||
      typeof parsed.provider !== 'string' ||
      !(KNOWN_PROVIDERS as readonly string[]).includes(parsed.provider) ||
      typeof parsed.createdMs !== 'number' ||
      typeof parsed.lastUsedMs !== 'number'
    ) {
      return null
    }
    const provider = parsed.provider as ProviderId
    const base: DeckSessionRecordBase = {
      id: parsed.id,
      provider,
      createdMs: parsed.createdMs,
      lastUsedMs: parsed.lastUsedMs,
    }
    // Defense-in-depth: providerSessionId gets pushed straight into a
    // `--session-id` / `--resume` argv slot (CLI) or used as a file
    // path (pi-agent). spawn() with array form already blocks shell
    // injection, but a tampered metadata file could still sneak
    // unexpected content into a flag value. Validate per provider:
    //   - claude-cli: must be a UUID v4 (the CLI's own format).
    //   - pi-agent: must be an absolute path inside the deck's chat
    //     dir; chats.ts already validates the path on use, here we
    //     just reject obvious garbage.
    const providerSessionId = validProviderSessionId(provider, parsed.providerSessionId)
    const summary = typeof parsed.summary === 'string' ? parsed.summary : ''
    // The active-record invariant: needs both a valid resume hint AND
    // a non-empty summary. If either is missing we treat the record
    // as a draft — the disk persisted it, but we can't reconstruct an
    // active state from it (typically a malformed legacy row that
    // should be ignored / cleaned up by chats:list).
    if (providerSessionId !== null && summary.length > 0) {
      return { ...base, kind: 'active', providerSessionId, summary }
    }
    return { ...base, kind: 'draft' }
  } catch (e) {
    console.warn('[session-store] failed to read', file, e)
    return null
  }
}

/** Atomic write via tmp + rename. Best-effort — a failed write only
 *  loses the on-disk hint for this session.
 *
 *  Only `ActiveSessionRecord` is persistable: the type system forbids
 *  passing a draft (drafts have no resume hint to preserve and no
 *  summary to display, so writing them just leaves debris). The
 *  promotion happens at the backend's first-success path via
 *  `promoteToActive`. */
export async function saveSession(chatKey: string, record: ActiveSessionRecord): Promise<void> {
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
