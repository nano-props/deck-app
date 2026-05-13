import type { WebContents } from 'electron'
import { createDeckAiSession } from '#/main/ai/session/index.ts'
import { createClaudeCliSession } from '#/main/ai/claude-cli/session.ts'
import type { DeckAiSession, EditorAiEvent, SessionParams } from '#/main/ai/session/types.ts'
import type { DeckContext } from '#/main/deck-types.ts'
import { t } from '#/main/i18n/index.ts'
import { getSettings } from '#/main/settings.ts'
import { type ProviderId } from '#/main/secrets.ts'
import { getBackendDescriptor } from '#/main/ai/backend-descriptors.ts'
import { isDeckError } from '#/main/ai/errors.ts'
import { decideResumeStrategy } from '#/main/ai/resume-strategy.ts'
import { createSerialQueue } from '#/main/util/serial-queue.ts'
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
  //
  // Dispatch via the BackendDescriptor's `kind` field rather than
  // string matching: future provider additions only need to declare
  // their kind in `backend-descriptors.ts`. Adding a third kind
  // ('rest-api', 'wasm', ...) would force this switch to grow a case,
  // and the descriptor's `kind` union ensures TS exhaustiveness.
  const descriptor = getBackendDescriptor(p.record.provider)
  switch (descriptor.kind) {
    case 'cli':
      return createClaudeCliSession(p)
    case 'pi-agent':
      return createDeckAiSession(p)
  }
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

  const { enqueue: enqueueMutation } = createSerialQueue()

  function sendAiEvent(ev: EditorAiEvent): void {
    if (chromeWebContents.isDestroyed()) return
    try {
      chromeWebContents.send('ai:event', ev)
    } catch {
    }
  }

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

  function localizeFatal(err: unknown): string {
    if (isDeckError(err)) {
      switch (err.code) {
        case 'CLI_NOT_FOUND':
          return t('composer.disabled.no-cli')
        default: {
          const _exhaustive: never = err.code
          void _exhaustive
        }
      }
    }
    return err instanceof Error ? err.message : String(err)
  }

  function emitFatal(err: unknown, attemptedProvider: ProviderId): void {
    sendAiEvent({ type: 'deck:fatal', error: localizeFatal(err) })
    sendAiEvent({
      type: 'deck:session_bound',
      provider: attemptedProvider,
      resumed: false,
      resumeSurvivesReopen: false,
      degraded: true,
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
    const { effectiveRecord, resumeSurvivesReopen } = decideResumeStrategy(record, deck.kind)
    if (record.kind === 'active' && effectiveRecord.kind === 'draft') {
      console.info('[AiSessionManager] dropped stale resume hint', {
        recordId: record.id,
        provider: record.provider,
        deckKind: deck.kind,
      })
    }
    let built: DeckAiSession
    try {
      built = await buildBackend({
        sender: chromeWebContents,
        rootDir: deck.rootDir,
        resumeSurvivesReopen,
        chatKey: deck.sourcePath,
        deckName: deck.manifest.name,
        record: effectiveRecord,
        onMutation,
        capturePreview,
      })
    } catch (err) {
      console.warn('[AiSessionManager] backend build failed', {
        recordId: record.id,
        provider: record.provider,
        deckKind: deck.kind,
        sourcePath: deck.sourcePath,
        err,
      })
      throw err
    }
    if (!getDeck() || chromeWebContents.isDestroyed()) {
      await built.dispose().catch(() => {})
      return
    }
    session = built
    sendAiEvent({
      type: 'deck:session_bound',
      provider: effectiveRecord.provider,
      resumed: effectiveRecord.kind === 'active',
      resumeSurvivesReopen,
    })
  }

  async function ensureImpl(): Promise<void> {
    if (session) return
    const deck = getDeck()
    if (!deck) return
    await whenChromeReady()
    const currentDeck = getDeck()
    if (!currentDeck || chromeWebContents.isDestroyed()) return
    const recent = await mostRecentSession(currentDeck.sourcePath, currentDeck.kind)
    const settings = await getSettings()
    try {
      if (recent) {
        await bindNew(recent)
        return
      }
      await bindNew(newSessionRecord(settings.ai.provider))
    } catch (err) {
      console.warn('[AiSessionManager] ensure: first bindNew failed', {
        recordId: recent?.id,
        provider: recent?.provider ?? settings.ai.provider,
        deckKind: currentDeck.kind,
        sourcePath: currentDeck.sourcePath,
        err,
      })
      if (recent) {
        try {
          await bindNew(newSessionRecord(settings.ai.provider))
          return
        } catch (err2) {
          console.error('[AiSessionManager] ensure: fresh session also failed; window has no AI session', {
            provider: settings.ai.provider,
            deckKind: currentDeck.kind,
            sourcePath: currentDeck.sourcePath,
            err: err2,
          })
          emitFatal(err2, settings.ai.provider)
          return
        }
      }
      emitFatal(err, settings.ai.provider)
    }
  }

  async function switchToSessionImpl(id: string): Promise<void> {
    const deck = getDeck()
    if (!deck) return
    const target = await readSession(deck.sourcePath, id)
    if (!target) {
      await clearActive()
      await ensureImpl()
      return
    }
    await clearActive()
    await whenChromeReady()
    sendAiEvent({ type: 'deck:session_reset' })
    try {
      await bindNew(target)
    } catch (err) {
      console.warn('[AiSessionManager] failed to switch to session, falling back', {
        recordId: target.id,
        provider: target.provider,
        err,
      })
      sendAiEvent({ type: 'deck:fatal', error: t('chat.switchFallback') })
      await ensureImpl()
    }
  }

  async function newChatImpl(): Promise<void> {
    const deck = getDeck()
    if (!deck) return
    await clearActive()
    await whenChromeReady()
    sendAiEvent({ type: 'deck:session_reset' })
    const settings = await getSettings()
    try {
      await bindNew(newSessionRecord(settings.ai.provider))
    } catch (err) {
      console.warn('[AiSessionManager] could not create new chat', {
        provider: settings.ai.provider,
        sourcePath: deck.sourcePath,
        err,
      })
      emitFatal(err, settings.ai.provider)
    }
  }

  return {
    get() {
      return session
    },

    ensure: () => enqueueMutation(ensureImpl),
    switchToSession: (id) => enqueueMutation(() => switchToSessionImpl(id)),
    newChat: () => enqueueMutation(newChatImpl),
    teardown: () => enqueueMutation(clearActive),

    emitSessionResetIfActive(): void {
      if (!session) return
      sendAiEvent({ type: 'deck:session_reset' })
    },
  }
}
