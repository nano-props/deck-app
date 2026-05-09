import { Agent } from '@earendil-works/pi-agent-core'
import { convertToLlm, shouldCompact } from '@earendil-works/pi-coding-agent'
import { buildModel } from '#/main/ai/provider.ts'
import { checkAiReadiness } from '#/main/ai/readiness.ts'
import { createDeckTools } from '#/main/ai/tools.ts'
import {
  openDeckChatSession,
  openDeckSessionManager,
  persistAgentMessages,
  resetDeckSessionManager,
  restoredMessages,
} from '#/main/chats.ts'
import { getSecret, type ProviderId } from '#/main/secrets.ts'
import { getSettings, resolveModel } from '#/main/settings.ts'
import { contextTokensFromBranch } from '#/main/ai/session/context-usage.ts'
import { safeSend } from '#/main/ai/session/safe-send.ts'
import { buildSystemPrompt } from '#/main/ai/session/system-prompt.ts'
import type { DeckAiSession, SendResult, SessionParams } from '#/main/ai/session/types.ts'

/**
 * One Agent per AppWindow with a deck loaded.
 *
 * Responsibilities:
 *   - Build an `Agent` (pi-agent-core) wired to the deck's rootDir for
 *     tool execution and to the current Settings for provider / model /
 *     key. Tools come from pi-coding-agent's standard factories with a
 *     sandbox wrapper (see ai/tools.ts).
 *   - Forward every `AgentEvent` to the renderer via
 *     `webContents.send` on channel 'ai:event'. Synthesize a few
 *     `deck:*` events alongside (file changes, history replay, context
 *     usage, fatal errors) so the renderer only needs one listener.
 *   - Persist the transcript via pi-coding-agent's `SessionManager`
 *     (wrapped in chats.ts). Session files live under
 *     `userData/chats/<deckId>/` — one per deck, pi manages the file
 *     within that directory.
 *   - Emit a `deck:context_usage` event after every run so the
 *     renderer can show a context-fill indicator. When `shouldCompact`
 *     fires we also emit `deck:context_warning` — pi's public API does
 *     not yet export `prepareCompaction`, so automatic compaction is
 *     not wired; the user gets a nudge to reset or abbreviate. Once pi
 *     exposes the preparation step, we'll flip this to real compaction
 *     without changing the event shape.
 */
export async function createDeckAiSession(params: SessionParams): Promise<DeckAiSession> {
  const { sender, rootDir, chatKey } = params

  const systemPrompt = await buildSystemPrompt(params)

  const tools = createDeckTools({
    rootDir,
    onFileChange: (relPath) => {
      // Fan out to two consumers: the renderer (for live reload UX) and
      // the window (so close-time save sees `dirty=true` reliably).
      // We can't rely on chokidar alone — its debounce + late-firing
      // semantics race against the window-close path.
      safeSend(sender, 'ai:event', { type: 'deck:file_change', path: relPath })
      params.onMutation?.()
    },
  })

  // Seed the Agent with the currently-configured model so
  // `initialState.model` is a real `Model<any>` (not a cast-over-undefined
  // placeholder). `send` re-reads Settings on each turn so mid-session
  // changes still take effect. If the user hasn't configured a provider
  // yet `buildModel` throws — we let `send` surface that as a
  // `deck:fatal` event and seed with a sentinel that `agent.prompt()`
  // will never see (send overwrites it first).
  let initialModel: ReturnType<typeof buildModel> | undefined
  try {
    const settings = await getSettings()
    initialModel = buildModel({
      provider: settings.ai.provider,
      model: resolveModel(settings),
      custom: settings.ai.custom,
    })
  } catch {
    // Missing/invalid config — `send` will re-try and emit a fatal event.
  }

  // Open (or resume) the pi-managed SessionManager for this deck.
  // History switcher passes an explicit `sessionPath` to load a
  // specific past session; bare openDeckSessionManager picks the most
  // recent / makes a new one.
  const sessionManager = params.sessionPath
    ? openDeckChatSession(chatKey, rootDir, params.sessionPath)
    : openDeckSessionManager(chatKey, rootDir)
  const priorMessages = restoredMessages(sessionManager)

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model: initialModel as never,
      tools,
      // Seeding `messages` here means the next `agent.prompt()` call
      // sees the restored transcript as context — the model keeps
      // continuity across app restarts.
      messages: priorMessages,
    },
    // Use pi's convertToLlm rather than pi-agent-core's default. The
    // default silently drops anything that isn't user/assistant/toolResult
    // — which would throw away compactionSummary / branchSummary (pi's
    // synthetic role that represents a post-compaction summary). pi's
    // convertToLlm rewrites those as a `user` message carrying the
    // summary text.
    convertToLlm,
    // pi-agent-core passes `provider` as a string; our ProviderId is a
    // subset of that space.
    getApiKey: async (provider) => {
      return (await getSecret(provider as ProviderId)) ?? undefined
    },
  })

  function emitContextUsage(): void {
    if (!agent.state.model) return
    const tokens = contextTokensFromBranch(sessionManager.getBranch())
    // Custom providers have contextWindow=0 (see provider.ts — we
    // don't know the real value) so the indicator is hidden for them.
    const contextWindow = agent.state.model.contextWindow
    if (!contextWindow) return
    safeSend(sender, 'ai:event', { type: 'deck:context_usage', tokens, contextWindow })
  }

  // Cached settings snapshot refreshed on each `send` — the subscribe
  // callback below can't be async, so it reads from here instead of
  // re-loading settings on every agent_end.
  let runtimeSettingsSnapshot: Awaited<ReturnType<typeof getSettings>> | null = null

  // Forward every agent event to the renderer. Subscribe returns an
  // unsubscribe fn; we call it from `dispose`.
  //
  // On `agent_end` we also persist the run's new messages. Persistence
  // is fire-and-forget: a missed append is a recoverable annoyance,
  // not a crash. After persisting we emit a context-usage update so
  // the renderer status bar can refresh.
  const unsubscribe = agent.subscribe((event) => {
    safeSend(sender, 'ai:event', event)
    if (event.type === 'agent_end' && event.messages.length > 0) {
      try {
        persistAgentMessages(sessionManager, event.messages)
      } catch {
        // Persistence should never crash the session; any I/O error
        // here just means the transcript line won't survive restart.
      }
      emitContextUsage()

      // Proactive warning when context is nearly full. When pi exposes
      // `prepareCompaction` we can replace this with a real compact()
      // call — same event shape, different internals.
      try {
        const settings = runtimeSettingsSnapshot
        if (settings && agent.state.model) {
          const tokens = contextTokensFromBranch(sessionManager.getBranch())
          const contextWindow = agent.state.model.contextWindow ?? 0
          if (contextWindow && shouldCompact(tokens, contextWindow, settings.compaction)) {
            safeSend(sender, 'ai:event', {
              type: 'deck:context_warning',
              tokens,
              contextWindow,
            })
          }
        }
      } catch {
        // Warning emission is best-effort.
      }
    }
  })

  // Replay prior messages to the renderer so the chat comes up
  // populated. Send AFTER subscribing for deterministic ordering
  // (history first, then future events) — but BEFORE we return, so
  // callers of `ensureAiSession()` can assume the UI is primed once
  // their await resolves.
  if (priorMessages.length > 0) {
    safeSend(sender, 'ai:event', { type: 'deck:history_replay', messages: priorMessages })
    emitContextUsage()
  }

  async function send(text: string): Promise<SendResult> {
    // Reject overlapping sends. Without this, pi-agent throws "Agent is
    // already processing a prompt" — we'd catch and turn that into a
    // deck:fatal, which the renderer treats as a permanent error and
    // flips streaming=false even though the original turn is still
    // running. Surface as `busy` so the IPC layer can return a benign
    // {ok:false}; we deliberately do NOT emit deck:fatal here.
    if (agent.state.isStreaming) {
      return { ok: false, reason: 'busy', message: 'A turn is already in progress.' }
    }
    // Re-check readiness. The renderer's button gate is best-effort
    // (the user can clear a key in Settings between turns); without
    // this gate, a missing key would surface as a 401 from the
    // provider with an opaque error string. Surface as `not-ready` so
    // the renderer can produce an actionable hint instead of treating
    // the run as fatal.
    const readiness = await checkAiReadiness()
    if (!readiness.ready) {
      return { ok: false, reason: 'not-ready', message: `AI not configured: ${readiness.reason}` }
    }
    try {
      // Re-resolve model + key + compaction settings on each send so
      // the user can change Settings mid-session and have the next
      // message pick it up.
      const settings = await getSettings()
      runtimeSettingsSnapshot = settings
      const model = buildModel({
        provider: settings.ai.provider,
        model: resolveModel(settings),
        custom: settings.ai.custom,
      })
      agent.state.model = model

      await agent.prompt(text)
      return { ok: true }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // Genuine run failure — emit deck:fatal so the renderer's chat
      // shows an error chip and resets streaming=false, AND return the
      // error so the IPC caller can also reflect it.
      safeSend(sender, 'ai:event', { type: 'deck:fatal', error: message })
      return { ok: false, reason: 'error', message }
    }
  }

  /**
   * Abort the in-flight turn. Returns a Promise that resolves once the
   * agent reports idle, so callers (`ai:abort` IPC, `reset`, the window
   * close path) can sequence a follow-up send without racing the
   * still-shutting-down agent. A still-running turn would otherwise
   * cause the very next send to hit the "already processing" guard.
   *
   * Bounded by a 500ms timeout: an unresponsive agent should not pin
   * the close path. The timeout is paired with a `clearTimeout` so the
   * pending timer is released on a fast idle, instead of dangling for
   * 500ms after every abort.
   */
  async function abort(): Promise<void> {
    if (!agent.state.isStreaming) return
    agent.abort()
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 500)
    })
    try {
      await Promise.race([agent.waitForIdle().catch(() => {}), timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * Ordering matters here:
   *
   *   1. If a run is active, abort and wait for it to settle.
   *      Otherwise its `agent_end` listener will call
   *      `persistAgentMessages` *after* we've started a fresh session,
   *      resurrecting stale messages onto a transcript the user just
   *      asked us to clear.
   *   2. Roll over to a new session file (see chats.ts::resetDeckSessionManager
   *      for why the old file is deleted instead of kept).
   *   3. Clear the Agent's in-memory state. Done last so any
   *      still-pending listener has already seen consistent state by
   *      the time it fires.
   *   4. Tell the renderer to drop its DOM.
   */
  async function reset(): Promise<void> {
    // Wait without a timeout: reset rolls over the SessionManager and
    // resets agent state. If we returned before the previous run truly
    // settled, its `agent_end` listener would still fire and run
    // `persistAgentMessages` against the SessionManager we just rolled
    // over — landing the old transcript on the new session file. The
    // 500ms ceiling in abort() is fine for the IPC-abort and
    // window-close paths because those don't subsequently mutate the
    // SessionManager; here a slow abort would corrupt persistence.
    if (agent.state.isStreaming) {
      agent.abort()
      await agent.waitForIdle().catch(() => {})
    }
    resetDeckSessionManager(sessionManager)
    agent.reset()
    safeSend(sender, 'ai:event', { type: 'deck:session_reset' })
  }

  async function dispose(): Promise<void> {
    unsubscribe()
    if (agent.state.isStreaming) {
      agent.abort()
      // Best effort — don't wait forever. If the run hangs, the window
      // is going away anyway.
      await Promise.race([agent.waitForIdle(), new Promise((r) => setTimeout(r, 500))])
    }
  }

  return {
    send,
    abort,
    reset,
    dispose,
    getSessionFile: () => sessionManager.getSessionFile() ?? null,
  }
}
