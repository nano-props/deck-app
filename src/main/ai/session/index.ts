import { Agent, type AgentMessage, type ThinkingLevel } from '@earendil-works/pi-agent-core'
import { convertToLlm, shouldCompact } from '@earendil-works/pi-coding-agent'
import type { WebContents } from 'electron'
import { buildModel } from '#/main/ai/provider.ts'
import { checkAiReadiness } from '#/main/ai/readiness.ts'
import { createDeckTools } from '#/main/ai/tools/index.ts'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import {
  deckChatDir,
  openDeckChatSession,
  persistAgentMessages,
  restoredMessages,
} from '#/main/chats.ts'
import { getSecret, type ProviderId } from '#/main/secrets.ts'
import { getSettings, resolveModel, type Settings } from '#/main/settings.ts'
import { deriveSummary, saveSession } from '#/main/ai/session-store.ts'
import { contextTokensFromBranch } from '#/main/ai/session/context-usage.ts'
import { buildSystemPrompt } from '#/main/ai/session/system-prompt.ts'
import type { ChatUiContext, DeckAiSession, SendResult, SessionParams } from '#/main/ai/session/types.ts'

/** webContents.send wrapper that no-ops once the view is gone. */
function safeSend(sender: WebContents, channel: string, payload: unknown): void {
  if (sender.isDestroyed()) return
  try {
    sender.send(channel, payload)
  } catch {
    // Destroyed between the check and the send — teardown race.
  }
}

/**
 * Race a Promise against a timeout. Returns `'settled'` if `p` finished
 * first (errors swallowed), `'timeout'` otherwise. Releases the timer
 * on whichever side wins — without `clearTimeout` we'd leak a pending
 * timer for the full duration on every fast resolution.
 *
 * Callers that need to react to the timeout (e.g. skip a follow-up
 * mutation that would corrupt state) must check the return value.
 */
async function withTimeout(p: Promise<unknown>, ms: number): Promise<'settled' | 'timeout'> {
  let timer!: ReturnType<typeof setTimeout>
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms)
  })
  const settled: Promise<'settled'> = p.catch(() => undefined).then(() => 'settled')
  try {
    return await Promise.race([settled, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * One Agent per AppWindow with a deck loaded.
 *
 * Responsibilities:
 *   - Build an `Agent` (pi-agent-core) wired to the deck's rootDir for
 *     tool execution and to the current Settings for provider / model /
 *     key. Tools come from pi-coding-agent's standard factories with a
 *     sandbox wrapper (see ai/tools/).
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
  const { sender, rootDir, chatKey, record } = params

  // The deck session record is the source of truth for "which provider /
  // which transcript". Live mutable copy so the adapter can update
  // lastUsedMs / providerSessionId / summary on each turn without
  // forcing the manager to re-pass a refreshed record on every send.
  const liveRecord = { ...record }

  const systemPrompt = await buildSystemPrompt(params)
  let systemPromptUiContextKey = ''

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
    capturePreview: params.capturePreview,
  })

  // Seed with the model for this session's locked provider so the
  // pre-first-turn `emitContextUsage` (fired during history_replay)
  // reports a real contextWindow instead of pi's DEFAULT_MODEL
  // placeholder (contextWindow=0). `send` re-reads Settings every turn,
  // so model/thinkingLevel stay live. If buildModel throws — missing
  // key, broken custom config — we leave the field unset and pi falls
  // back to DEFAULT_MODEL until `send` rebuilds with a usable model.
  let initialModel: ReturnType<typeof buildModel> | undefined
  let initialThinking: ThinkingLevel | undefined
  try {
    const settings = await getSettings()
    const synthetic: Settings = { ...settings, ai: { ...settings.ai, provider: liveRecord.provider } }
    initialModel = buildModel({
      provider: liveRecord.provider,
      model: resolveModel(synthetic),
      custom: settings.ai.custom,
    })
    initialThinking = settings.ai.thinkingLevel
  } catch {
    // Missing/invalid config — `send` will re-try and emit a fatal event.
  }

  // Open the pi SessionManager corresponding to this deck-level
  // session. record.providerSessionId, when set, is the absolute
  // path to pi's JSONL — a session that has already had at least one
  // successful turn. When null (fresh deck session), we mint a new
  // in-memory SessionManager rooted at the deck's chat directory; pi
  // flushes it to disk on the first assistant message, at which point
  // we also write the resulting file path back into the record's
  // `providerSessionId` for future resumes.
  let sessionManager: SessionManager
  if (liveRecord.providerSessionId) {
    sessionManager = openDeckChatSession(chatKey, rootDir, liveRecord.providerSessionId)
  } else {
    const piDir = deckChatDir(chatKey)
    sessionManager = SessionManager.continueRecent(rootDir, piDir)
    // `continueRecent` may have reattached to a stale file from a
    // previous deck session. Force a fresh file so two deck sessions
    // never share a pi transcript.
    sessionManager.newSession()
  }
  const priorMessages = restoredMessages(sessionManager)

  const agent = new Agent({
    initialState: {
      systemPrompt,
      // Omitted when buildModel threw; pi falls back to DEFAULT_MODEL.
      // `send` overwrites this with a fresh model before any LLM call.
      ...(initialModel ? { model: initialModel } : {}),
      // Same logic: `send` re-reads thinkingLevel each turn so a
      // settings change between turns lands on the next prompt.
      // Default 'off' (pi's own default) when settings load failed.
      ...(initialThinking ? { thinkingLevel: initialThinking } : {}),
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

  /**
   * Emit a context-usage event and return the (tokens, contextWindow)
   * pair so callers running in the same event-loop tick can reuse them
   * without re-walking the branch (the agent_end listener wants the
   * same numbers to evaluate `shouldCompact`).
   *
   * Returns null when the model has no known contextWindow — placeholder
   * (DEFAULT_MODEL) or custom provider without a declared window.
   */
  function emitContextUsage(): { tokens: number; contextWindow: number } | null {
    const contextWindow = agent.state.model.contextWindow
    if (!contextWindow) return null
    const tokens = contextTokensFromBranch(sessionManager.getBranch())
    safeSend(sender, 'ai:event', { type: 'deck:context_usage', tokens, contextWindow })
    return { tokens, contextWindow }
  }

  // Cached settings snapshot refreshed on each `send` — the subscribe
  // callback below can't be async, so it reads from here instead of
  // re-loading settings on every agent_end.
  let runtimeSettingsSnapshot: Settings | null = null

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
      // Drop the synthetic empty-assistant message that pi appends in
      // its `handleRunFailure` path (see Agent.handleRunFailure: an
      // aborted/errored run synthesizes an assistant turn with
      // `content: [{type:'text',text:''}]` and stopReason
      // 'aborted'/'error'). Persisting it bloats the transcript across
      // every Stop press; restoring it on next open does nothing useful.
      // We deliberately keep aborted/errored messages that *do* carry
      // partial content — those represent real model output the user
      // saw and should persist.
      const persistable = event.messages.filter((m) => !isSyntheticAbortMessage(m))
      if (persistable.length > 0) {
        try {
          persistAgentMessages(sessionManager, persistable)
        } catch {
          // Persistence should never crash the session; any I/O error
          // here just means the transcript line won't survive restart.
        }
        // Refresh the deck-session metadata so future "open this deck"
        // resumes the right pi JSONL and the history popover shows
        // accurate fields. pi defers its first disk flush until an
        // assistant message lands, so we only trust getSessionFile()
        // after persistAgentMessages has run.
        const piFile = sessionManager.getSessionFile() ?? null
        if (piFile) liveRecord.providerSessionId = piFile
        if (!liveRecord.summary) {
          for (const m of persistable) {
            if (m.role === 'user') {
              const text = stringifyUserContent(m.content)
              if (text) {
                liveRecord.summary = deriveSummary(text)
                break
              }
            }
          }
        }
        liveRecord.lastUsedMs = Date.now()
        void saveSession(chatKey, liveRecord)
      }
      const usage = emitContextUsage()

      // Proactive warning when context is nearly full. When pi exposes
      // `prepareCompaction` we can replace this with a real compact()
      // call — same event shape, different internals.
      try {
        const settings = runtimeSettingsSnapshot
        if (usage && settings && shouldCompact(usage.tokens, usage.contextWindow, settings.compaction)) {
          safeSend(sender, 'ai:event', {
            type: 'deck:context_warning',
            tokens: usage.tokens,
            contextWindow: usage.contextWindow,
          })
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

  async function send(text: string, uiContext?: ChatUiContext): Promise<SendResult> {
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
    const readiness = await checkAiReadiness(liveRecord.provider)
    if (!readiness.ready) {
      return { ok: false, reason: 'not-ready', message: `AI not configured: ${readiness.reason}` }
    }
    // Re-resolve model + key on each send. The session's *provider* is
    // locked to the record at creation time (so a user changing
    // settings.provider mid-deck doesn't silently retarget this
    // conversation), but model/thinkingLevel/key for that provider
    // come from the latest settings — so picking a different model in
    // Settings still applies on the next turn.
    try {
      const settings = await getSettings()
      runtimeSettingsSnapshot = settings
      const provider = liveRecord.provider
      const synthetic: Settings = { ...settings, ai: { ...settings.ai, provider } }
      const model = buildModel({
        provider,
        model: resolveModel(synthetic),
        custom: settings.ai.custom,
      })
      agent.state.model = model
      agent.state.thinkingLevel = settings.ai.thinkingLevel
      if (uiContext) {
        const nextUiContextKey = uiContextKey(uiContext)
        if (nextUiContextKey !== systemPromptUiContextKey) {
          agent.state.systemPrompt = await buildSystemPrompt(params, uiContext)
          systemPromptUiContextKey = nextUiContextKey
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      safeSend(sender, 'ai:event', { type: 'deck:fatal', error: message })
      return { ok: false, reason: 'error', message }
    }

    // pi's `runWithLifecycle` already converts in-loop errors into a
    // synthetic assistant message + agent_end (with stopReason='error'
    // and `errorMessage`), which the renderer surfaces via its
    // message_end handler. So `prompt()` is not expected to throw; if
    // it ever does (pi-internal bug, sync setup throw), the catch
    // returns the error to the IPC caller without re-emitting
    // deck:fatal — that would double-render the error chip.
    try {
      await agent.prompt(text)
      return { ok: true }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
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
    // Best-effort wait — a hung tool can't be allowed to pin the IPC
    // caller. We don't branch on settled vs. timeout here: either way
    // we hand control back so the renderer can issue the next send.
    await withTimeout(agent.waitForIdle(), 500)
  }

  async function dispose(): Promise<void> {
    unsubscribe()
    if (agent.state.isStreaming) {
      agent.abort()
      // Best effort — window is going away anyway.
      await withTimeout(agent.waitForIdle(), 500)
    }
  }

  return {
    send,
    abort,
    dispose,
    getRecord: () => liveRecord,
  }
}

/**
 * Best-effort flatten of an AgentMessage's user-content into preview
 * text. AgentMessage.content can be a string, a structured array, or a
 * mix of text/image blocks; we only need the text portion. Returns ''
 * if no usable text is found.
 */
function stringifyUserContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const c of content) {
    if (typeof c === 'string') parts.push(c)
    else if (
      c &&
      typeof c === 'object' &&
      (c as { type?: unknown }).type === 'text' &&
      typeof (c as { text?: unknown }).text === 'string'
    ) {
      parts.push((c as { text: string }).text)
    }
  }
  return parts.join(' ')
}

/**
 * Identify the synthetic stub assistant message that pi emits when a
 * run is aborted/errored before producing any output. pi constructs it
 * with a single empty text block and stopReason 'aborted'/'error' (see
 * Agent.handleRunFailure). Aborted runs that *did* produce partial
 * output have a real (non-empty) content array and aren't matched here
 * — those still represent model output the user saw and should
 * persist.
 */
function isSyntheticAbortMessage(m: AgentMessage): boolean {
  if (m.role !== 'assistant') return false
  if (m.stopReason !== 'aborted' && m.stopReason !== 'error') return false
  return m.content.every((c) => c.type === 'text' && c.text.length === 0)
}

function uiContextKey(uiContext: ChatUiContext): string {
  return `${uiContext.lang}\0${uiContext.langPref}\0${uiContext.theme}\0${uiContext.themePref}`
}
