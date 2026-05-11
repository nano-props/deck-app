import type { WebContents } from 'electron'
import { createDeckAiSession } from '#/main/ai/session/index.ts'
import type { DeckAiSession } from '#/main/ai/session/types.ts'
import type { DeckContext } from '#/main/deck-types.ts'
import type { Rect } from '#/main/window-shell.ts'

/**
 * Owns the AI chat session lifecycle for a single AppWindow.
 *
 * Responsibilities:
 *   - Lazy-create the session once both a deck is loaded and the chrome
 *     WebContents has finished its initial load (so `deck:history_replay`
 *     emitted at session construction reaches a renderer that's already
 *     subscribed to `ai:event`).
 *   - Switch between persisted chat transcripts (History popover): abort
 *     the in-flight turn, dispose the runtime, replay a fresh session
 *     pointed at the picked file. Falls back to the default session if
 *     the file is missing or corrupt rather than leaving the window
 *     session-less.
 *   - Tear down on deck close, with an explicit `session_reset` IPC
 *     before `dispose()` so the renderer drops streaming flags / chat
 *     nodes before the listener detaches.
 *
 * The manager holds no back-reference to AppWindow. All AppWindow-side
 * concerns (mark-dirty, capture preview) flow in via callbacks at
 * construction time, mirroring `DeckViewController`'s decoupling
 * pattern. This is a factory rather than a class because it owns a
 * single field (`session`) and has no reentrancy state machine —
 * matching the style of `createDeckAiSession` itself.
 */

export interface AiSessionManager {
  get(): DeckAiSession | null

  /** Create the session for the currently-open deck. No-op if one
   *  exists, if no deck is loaded, or if the chrome WebContents was
   *  destroyed during the readiness wait. Awaits chrome-ready first
   *  so a synchronous `deck:history_replay` doesn't fire before the
   *  renderer has registered its `ai:event` listener. */
  ensure(): Promise<void>

  /** Replace the active session with one pointing at `sessionPath`.
   *  Aborts any in-flight turn first. If the requested file is missing
   *  or corrupted, falls back to the deck's default session so the
   *  window doesn't end up session-less. */
  switch(sessionPath: string): Promise<void>

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
  /** Forwarded to createDeckAiSession's onMutation hook. */
  onMutation: () => void
  /** Forwarded to createDeckAiSession's capturePreview hook. */
  capturePreview: () => Promise<{ dataUrl: string; rect: Rect } | null>
}

export function createAiSessionManager(deps: AiSessionManagerDeps): AiSessionManager {
  const { chromeWebContents, getDeck, onMutation, capturePreview } = deps
  let session: DeckAiSession | null = null

  /**
   * Resolve when chromeView has finished its initial load. Uses
   * `webContents.isLoading()` as the fast path, `did-finish-load` /
   * `did-fail-load` as the slow path. Safe after disposal.
   *
   * The `destroyed` listener is load-bearing: if the user closes the
   * window during the very narrow window between our `isDestroyed()`
   * check and a load-event firing, the WebContents transitions through
   * destruction without emitting `did-finish-load` or `did-fail-load`.
   * Without the destroy hook the awaiter (in `ensure()` / `switch()`)
   * would hang forever, parking the AI-session creation flow on a
   * dead reference. Electron's own `loadURL` plumbing uses the same
   * three-event coalesce — see web-contents.ts::_awaitNextLoad in the
   * Electron source.
   */
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

  return {
    get() {
      return session
    },

    async ensure(): Promise<void> {
      if (session) return
      const deck = getDeck()
      if (!deck) return
      // Wait for the chrome renderer to finish loading before we construct
      // the session. Session construction can emit `deck:history_replay`
      // synchronously (when there's a prior transcript on disk), and if
      // the renderer hasn't registered its `ai:event` listener yet that
      // message is lost. On cold start, chromeView.loadFile races deck
      // extraction — a warm filesystem cache can win the race.
      await whenChromeReady()
      const currentDeck = getDeck()
      if (!currentDeck || chromeWebContents.isDestroyed()) return
      const created = await createDeckAiSession({
        sender: chromeWebContents,
        rootDir: currentDeck.rootDir,
        chatKey: currentDeck.sourcePath,
        deckName: currentDeck.manifest.name,
        onMutation,
        capturePreview,
      })
      // Window-close may have already run during the second await.
      // Dispose immediately and bail.
      if (!getDeck() || chromeWebContents.isDestroyed()) {
        await created.dispose().catch(() => {})
        return
      }
      session = created
    },

    async switch(sessionPath: string): Promise<void> {
      const deck = getDeck()
      if (!deck) return
      if (session) {
        try {
          await session.abort()
        } catch {
          // session already disposed mid-await — fine
        }
        const prior = session
        session = null
        await prior.dispose().catch(() => {})
      }
      await whenChromeReady()
      const currentDeck = getDeck()
      if (!currentDeck || chromeWebContents.isDestroyed()) return
      // Tell the renderer to drop the prior chat DOM before we replay the
      // new transcript — otherwise the two would concatenate visually.
      try {
        chromeWebContents.send('ai:event', { type: 'deck:session_reset' })
      } catch {
        // Destroyed between the check and the send — teardown race.
      }
      // If sessionPath has been removed/corrupted out from under us
      // (external delete, partial transfer), don't leave the window
      // session-less — fall back to the default session so the user can
      // keep chatting. Caller's `chats:switch` IPC swallows the throw,
      // but a session-less window forces the renderer into a no-session
      // dead-end until the user reopens the deck.
      let created: DeckAiSession
      try {
        created = await createDeckAiSession({
          sender: chromeWebContents,
          rootDir: currentDeck.rootDir,
          chatKey: currentDeck.sourcePath,
          deckName: currentDeck.manifest.name,
          sessionPath,
          onMutation,
          capturePreview,
        })
      } catch (err) {
        console.warn('[AiSessionManager] switch: failed to open requested session, falling back to default', err)
        created = await createDeckAiSession({
          sender: chromeWebContents,
          rootDir: currentDeck.rootDir,
          chatKey: currentDeck.sourcePath,
          deckName: currentDeck.manifest.name,
          onMutation,
          capturePreview,
        })
      }
      if (!getDeck() || chromeWebContents.isDestroyed()) {
        await created.dispose().catch(() => {})
        return
      }
      session = created
    },

    async teardown(): Promise<void> {
      if (!session) return
      const prior = session
      session = null
      await prior.dispose().catch(() => {})
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
