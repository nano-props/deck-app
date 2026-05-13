import type { WebContents } from 'electron'
import { createDeckAiSession } from '#/main/ai/session/index.ts'
import { createClaudeCliSession } from '#/main/ai/cli/session.ts'
import type { DeckAiSession, SessionParams } from '#/main/ai/session/types.ts'
import type { DeckContext } from '#/main/deck-types.ts'
import { getSettings } from '#/main/settings.ts'
import { isCliProvider } from '#/main/secrets.ts'
import {
  type DeckSessionRecord,
  mostRecentSession,
  newSessionRecord,
  readSession,
} from '#/main/ai/session-store.ts'
import type { Rect } from '#/main/window-shell.ts'

/**
 * Owns the AI chat session lifecycle for a single AppWindow.
 *
 * The unit of work here is the *deck session* (see session-store.ts).
 * Each deck session is locked to one AI provider at creation time and
 * persists across app restarts as a metadata file under
 * `userData/chats/<deckId>/meta/`.
 *
 *   - `ensure()` resumes the most recently used deck session for the
 *     current deck. If none exists, it creates one bound to the user's
 *     current `settings.ai.provider`.
 *   - `newChat()` discards the active session in memory and mints a
 *     fresh deck session — bound to whatever provider is selected
 *     *now* in Settings. The user's preferred way of switching
 *     provider mid-deck (Phase 1: switching is allowed only at
 *     conversation boundaries).
 *   - `switchToSession(id)` loads a specific past session by id and
 *     uses *its recorded provider* — not the current settings — so a
 *     user looking at an old anthropic-flavored conversation gets pi
 *     even if they've since changed their default to claude-cli.
 *
 * The manager holds no back-reference to AppWindow. All AppWindow-side
 * concerns (mark-dirty, capture preview) flow in via callbacks at
 * construction time, mirroring `DeckViewController`'s decoupling
 * pattern.
 */

async function buildBackend(p: SessionParams): Promise<DeckAiSession> {
  // Decision is keyed off the deck session's own recorded provider,
  // NOT the current settings.ai.provider. This is what lets a user
  // open an old anthropic conversation while their default is now
  // claude-cli — the old session keeps running on pi.
  return isCliProvider(p.record.provider) ? createClaudeCliSession(p) : createDeckAiSession(p)
}

export interface AiSessionManager {
  /** Currently-bound deck session, or null when no deck is loaded /
   *  the session is still being constructed. */
  get(): DeckAiSession | null

  /** Resume (or create) the deck's most-recently-used session.
   *  No-op if a session is already bound. Awaits chrome-ready first
   *  so a synchronous `deck:history_replay` doesn't fire before the
   *  renderer has registered its `ai:event` listener. */
  ensure(): Promise<void>

  /** Replace the active session with the deck-session matching `id`.
   *  Aborts any in-flight turn first. Falls back to the deck's most
   *  recent session if `id` is unknown so the window doesn't end up
   *  session-less. The new backend matches the loaded session's
   *  recorded provider, regardless of current settings. */
  switchToSession(id: string): Promise<void>

  /** Discard the active session and create a fresh one bound to
   *  `settings.ai.provider` at this moment. The old session's
   *  metadata file (if it had a successful turn) stays on disk and
   *  appears in the history popover. */
  newChat(): Promise<void>

  /** Best-effort teardown. Always resolves. */
  teardown(): Promise<void>

  /** Tell the renderer to drop chat DOM. Used before teardown so the
   *  renderer's `streaming` flag can clear before the listener detaches.
   *  No-op when no session is active or the WebContents is destroyed. */
  emitSessionResetIfActive(): void
}

export interface AiSessionManagerDeps {
  /** Channel for ai:event sends and isDestroyed checks. */
  chromeWebContents: WebContents
  /** Pulls the current deck context at session-create time. */
  getDeck: () => DeckContext | null
  /** Forwarded to backend's onMutation hook. */
  onMutation: () => void
  /** Forwarded to backend's capturePreview hook. */
  capturePreview: () => Promise<{ dataUrl: string; rect: Rect } | null>
}

export function createAiSessionManager(deps: AiSessionManagerDeps): AiSessionManager {
  const { chromeWebContents, getDeck, onMutation, capturePreview } = deps
  let session: DeckAiSession | null = null

  function whenChromeReady(): Promise<void> {
    if (chromeWebContents.isDestroyed()) return Promise.resolve()
    if (!chromeWebContents.isLoading()) return Promise.resolve()
    return new Promise((resolve) => {
      const settle = () => {
        chromeWebContents.off('did-finish-load', settle)
        chromeWebContents.off('did-fail-load', settle)
        chromeWebContents.off('destroyed', settle)
        resolve()
      }
      chromeWebContents.once('did-finish-load', settle)
      chromeWebContents.once('did-fail-load', settle)
      chromeWebContents.once('destroyed', settle)
    })
  }

  /** Tear down the active session in place; caller decides what to
   *  build next. Idempotent. */
  async function clearActive(): Promise<void> {
    if (!session) return
    const prior = session
    session = null
    try {
      await prior.abort()
    } catch {
      // already settling
    }
    await prior.dispose().catch(() => {})
  }

  /** Mint a backend for `record` and bind it to the manager. Caller
   *  must have already torn down any prior session. Bails (and
   *  disposes the freshly-built backend) if the deck went away during
   *  the await. */
  async function bindNew(record: DeckSessionRecord): Promise<void> {
    const deck = getDeck()
    if (!deck || chromeWebContents.isDestroyed()) return
    const built = await buildBackend({
      sender: chromeWebContents,
      rootDir: deck.rootDir,
      chatKey: deck.sourcePath,
      deckName: deck.manifest.name,
      record,
      onMutation,
      capturePreview,
    })
    if (!getDeck() || chromeWebContents.isDestroyed()) {
      await built.dispose().catch(() => {})
      return
    }
    session = built
  }

  async function ensure(): Promise<void> {
    if (session) return
    const deck = getDeck()
    if (!deck) return
    await whenChromeReady()
    const currentDeck = getDeck()
    if (!currentDeck || chromeWebContents.isDestroyed()) return
    // Resume the deck's most-recent session if it has one. Otherwise
    // mint a brand-new record. If either path throws (stale path
    // after userData move, missing CLI binary, etc.), bail without
    // a session — the composer's readiness gate already shows the
    // user a "fix this in Settings" hint, and we'd rather open the
    // deck without AI than not open it at all.
    const recent = await mostRecentSession(currentDeck.sourcePath)
    const settings = await getSettings()
    try {
      if (recent) {
        await bindNew(recent)
        return
      }
      await bindNew(newSessionRecord(settings.ai.provider))
    } catch (err) {
      console.warn('[AiSessionManager] could not create AI session:', err)
      if (recent) {
        // Recent record was the problem (stale path, etc.) — try a
        // fresh record once before giving up.
        try {
          await bindNew(newSessionRecord(settings.ai.provider))
        } catch (err2) {
          console.warn('[AiSessionManager] fresh session also failed:', err2)
        }
      }
    }
  }

  return {
    get() {
      return session
    },

    ensure,

    async switchToSession(id: string): Promise<void> {
      const deck = getDeck()
      if (!deck) return
      const target = await readSession(deck.sourcePath, id)
      if (!target) {
        // Unknown id (deleted under us, etc.). Fall back to ensure() so
        // the window doesn't end up session-less.
        await clearActive()
        await ensure()
        return
      }
      await clearActive()
      // Drop the old chat DOM before the new session emits its
      // history_replay. Without this the renderer would concatenate
      // the two transcripts visually.
      if (!chromeWebContents.isDestroyed()) {
        try {
          chromeWebContents.send('ai:event', { type: 'deck:session_reset' })
        } catch {
          // teardown race
        }
      }
      await whenChromeReady()
      try {
        await bindNew(target)
      } catch (err) {
        console.warn('[AiSessionManager] failed to switch to session, falling back:', err)
        await ensure()
      }
    },

    async newChat(): Promise<void> {
      const deck = getDeck()
      if (!deck) return
      await clearActive()
      if (!chromeWebContents.isDestroyed()) {
        try {
          chromeWebContents.send('ai:event', { type: 'deck:session_reset' })
        } catch {
          // teardown race
        }
      }
      await whenChromeReady()
      // Brand-new record bound to whatever provider is currently
      // selected in Settings. Stays in memory until the first
      // successful turn writes it to disk. Swallow build errors
      // (CLI binary went missing, etc.) — readiness gate surfaces the
      // hint; better to leave the chat empty than crash the IPC.
      const settings = await getSettings()
      try {
        await bindNew(newSessionRecord(settings.ai.provider))
      } catch (err) {
        console.warn('[AiSessionManager] could not create new chat:', err)
      }
    },

    async teardown(): Promise<void> {
      await clearActive()
    },

    emitSessionResetIfActive(): void {
      if (!session) return
      if (chromeWebContents.isDestroyed()) return
      try {
        chromeWebContents.send('ai:event', { type: 'deck:session_reset' })
      } catch {
        // teardown race
      }
    },
  }
}
