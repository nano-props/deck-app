import { Agent, type AgentEvent, type AgentMessage } from '@mariozechner/pi-agent-core'
import type { Usage } from '@mariozechner/pi-ai'
import {
  calculateContextTokens,
  convertToLlm,
  estimateTokens,
  getLastAssistantUsage,
  shouldCompact,
  type SessionEntry,
  type SessionMessageEntry,
} from '@mariozechner/pi-coding-agent'
import type { WebContents } from 'electron'
import { buildModel } from '#/main/ai/provider.ts'
import { createDeckTools, describeDeckSource } from '#/main/ai/tools.ts'
import {
  openDeckSessionManager,
  persistAgentMessages,
  resetDeckSessionManager,
  restoredMessages,
} from '#/main/chats.ts'
import { getSecret, type ProviderId } from '#/main/secrets.ts'
import { getSettings, resolveModel } from '#/main/settings.ts'
import { formatDeckSkillsForPrompt } from '#/main/skills.ts'

/**
 * One Agent per Editor window.
 *
 * Responsibilities:
 *   - Build an `Agent` (pi-agent-core) wired to the Editor session's rootDir
 *     for tool execution and to the current Settings for provider / model /
 *     key. Tools come from pi-coding-agent's standard factories with a
 *     sandbox wrapper (see src/main/ai/tools.ts).
 *   - Forward every `AgentEvent` to the renderer via `webContents.send` on
 *     channel 'ai:event'. Synthesize a few `deck:*` events alongside
 *     (file changes, history replay, context usage, fatal errors) so the
 *     renderer only needs one listener.
 *   - Persist the transcript via pi-coding-agent's `SessionManager`
 *     (wrapped in src/main/chats.ts). Session files live under
 *     `userData/chats/<deckId>/` — one per deck, pi manages the file
 *     within that directory.
 *   - Emit a `deck:context_usage` event after every run so the renderer
 *     can show a context-fill indicator. When `shouldCompact` fires we
 *     also emit `deck:context_warning` — pi's public API does not yet
 *     export `prepareCompaction`, so automatic compaction is not wired;
 *     the user gets a nudge to reset or abbreviate. Once pi exposes the
 *     preparation step, we'll flip this to real compaction without
 *     changing the event shape.
 */

export interface DeckAiSession {
  send(text: string): Promise<void>
  abort(): void
  reset(): Promise<void>
  dispose(): Promise<void>
}

/**
 * Extra events we emit alongside pi-agent-core's AgentEvents. Kept on the
 * same IPC channel so the renderer only needs one listener.
 *
 * Our event `type`s are prefixed `deck:` so they cannot collide with
 * anything pi-agent-core might add (all its types are `agent_*` / `turn_*`
 * / `message_*` / `tool_execution_*`).
 */
export type EditorAiEvent =
  | AgentEvent
  | { type: 'deck:file_change'; path: string }
  | { type: 'deck:fatal'; error: string }
  | { type: 'deck:session_reset' }
  | { type: 'deck:history_replay'; messages: AgentMessage[] }
  | { type: 'deck:context_usage'; tokens: number; contextWindow: number }
  | { type: 'deck:context_warning'; tokens: number; contextWindow: number }

interface SessionParams {
  /**
   * WebContents we push AI events to — i.e. the Editor UI view. Decoupled
   * from the window so this module works the same whether the Editor UI
   * is a BrowserWindow (old architecture) or a WebContentsView inside a
   * BaseWindow (current).
   */
  sender: WebContents
  rootDir: string
  /** Human-visible deck name, used in the system prompt. */
  deckName: string
}

/**
 * Shape the system prompt around Deck authoring. pi-coding-agent's tools
 * are self-documenting, so we just orient the model: what a Deck is,
 * which tools it has, and the skill index. pi's `formatSkillsForPrompt`
 * emits the skill block with ABSOLUTE paths — the model reads SKILL.md
 * using the standard `read` tool, which we allowlist for the bundled
 * skills directory.
 */
async function buildSystemPrompt(params: SessionParams): Promise<string> {
  const description = await describeDeckSource(params.rootDir)
  const skillsBlock = formatDeckSkillsForPrompt()

  const lines = [
    `You are Deck AI, the assistant inside the Deck App Editor. You edit a single presentation called "${params.deckName}" by writing files in its Deck Source.`,
    '',
    `The Deck Source lives at: ${params.rootDir}`,
    '',
    'Tools available to you:',
    '- read / write / edit — text file authoring rooted at the Deck Source.',
    '- ls — list directory contents.',
    '- add_asset — Deck-specific: write binary assets (images / fonts / video) from base64.',
    '',
    'Prefer `edit` over `write` for incremental changes to existing files — it keeps diffs small.',
    'Use `add_asset` for binary media. `write` is for plain text.',
    '',
    'Current Deck Source contents:',
    description,
  ]

  if (skillsBlock) {
    lines.push(
      '',
      'Before non-trivial edits, consult any skill whose description matches the task by reading the file at its <location> path. Skill content is canonical — when it conflicts with general web advice, the skill wins.',
      '',
      skillsBlock,
    )
  }

  return lines.join('\n')
}

/**
 * Wrap `webContents.send` so we can no-op after the view is destroyed
 * without a try/catch at every call site.
 */
function safeSend(sender: WebContents, channel: string, payload: unknown): void {
  if (sender.isDestroyed()) return
  try {
    sender.send(channel, payload)
  } catch {
    // Destroyed between isDestroyed() and send() during teardown races —
    // not worth surfacing.
  }
}

/**
 * Estimate current context tokens. Prefers the authoritative `usage` field
 * from the last assistant message (real provider numbers), falling back to
 * pi's `estimateTokens` heuristic for messages with no usage attached.
 *
 * Mirrors pi's private `estimateContextTokens` — reimplemented here from
 * its public building blocks (`getLastAssistantUsage`,
 * `calculateContextTokens`, `estimateTokens`) so we don't depend on a
 * non-exported helper.
 *
 * Caveat: this walks message entries only, skipping compaction entries.
 * Before pi wires up real compaction that's the same as pi's own estimate;
 * after, our number will understate by the summary's token cost (pi would
 * turn the summary into a user message via convertToLlm and count it).
 * Fine as an indicator, but don't treat it as byte-accurate once
 * compaction is live.
 */
function contextTokensFromBranch(branch: SessionEntry[]): number {
  const usage: Usage | undefined = getLastAssistantUsage(branch)
  if (!usage) {
    let total = 0
    for (const entry of branch) {
      if (entry.type !== 'message') continue
      total += estimateTokens((entry as SessionMessageEntry).message)
    }
    return total
  }
  const base = calculateContextTokens(usage)
  // Messages after the last usage-bearing assistant message aren't covered
  // by provider numbers — estimate them. Walk back until we hit the
  // assistant message that produced `usage`, then stop.
  let trailing = 0
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]
    if (entry.type !== 'message') continue
    const msg = (entry as SessionMessageEntry).message
    if (msg.role === 'assistant' && (msg as { usage?: Usage }).usage) break
    trailing += estimateTokens(msg)
  }
  return base + trailing
}

export async function createDeckAiSession(params: SessionParams): Promise<DeckAiSession> {
  const { sender, rootDir } = params

  const systemPrompt = await buildSystemPrompt(params)

  const tools = createDeckTools({
    rootDir,
    onFileChange: (relPath) => safeSend(sender, 'ai:event', { type: 'deck:file_change', path: relPath }),
  })

  // Seed the Agent with the currently-configured model so `initialState.model`
  // is a real `Model<any>` (not a cast-over-undefined placeholder). `send`
  // re-reads Settings on each turn so mid-session changes still take effect.
  // If the user hasn't configured a provider yet `buildModel` throws —
  // we let `send` surface that as a `deck:fatal` event and seed with a
  // sentinel that `agent.prompt()` will never see (send overwrites it first).
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
  // `restoredMessages` returns the messages compiled from the current
  // branch with any compaction entries already applied — exactly what
  // we want to seed Agent.state.messages with.
  const sessionManager = openDeckSessionManager(rootDir)
  const priorMessages = restoredMessages(sessionManager)

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model: initialModel as never,
      tools,
      // Seeding `messages` here means the next `agent.prompt()` call sees
      // the restored transcript as context — the model keeps continuity
      // across app restarts.
      messages: priorMessages,
    },
    // Use pi's convertToLlm rather than pi-agent-core's default. The
    // default silently drops anything that isn't user/assistant/toolResult
    // — which would throw away compactionSummary / branchSummary (pi's
    // synthetic role that represents a post-compaction summary). pi's
    // convertToLlm rewrites those as a `user` message carrying the
    // summary text, which is what we want when pi's SessionManager
    // eventually writes a compaction entry into our transcript.
    convertToLlm,
    // pi-agent-core passes `provider` as a string; our ProviderId is a
    // subset of that space. Anthropic/OpenAI/Google provider strings match
    // pi-ai's builtin expectations. Custom providers use whatever provider
    // string the Model carries (see buildModel — we set it to the ProviderId).
    getApiKey: async (provider) => {
      return (await getSecret(provider as ProviderId)) ?? undefined
    },
  })

  function emitContextUsage(): void {
    if (!agent.state.model) return
    const tokens = contextTokensFromBranch(sessionManager.getBranch())
    // Custom providers have contextWindow=0 (see provider.ts — we don't
    // know the real value) so the indicator is hidden for them. If you
    // switch to a custom model and stop seeing the token bar, that's
    // why. Fix is to let the user declare a contextWindow in custom
    // config; deferring until a user actually asks.
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
  // On `agent_end` we also persist the run's new messages (user prompt +
  // assistant messages + tool results — pi-agent-core hands us exactly
  // those in `event.messages`). Persistence is fire-and-forget: a missed
  // append is a recoverable annoyance, not a crash. After persisting we
  // emit a context-usage update so the renderer status bar can refresh.
  const unsubscribe = agent.subscribe((event) => {
    safeSend(sender, 'ai:event', event)
    if (event.type === 'agent_end' && event.messages.length > 0) {
      try {
        persistAgentMessages(sessionManager, event.messages)
      } catch {
        // Persistence should never crash the session; any I/O error here
        // just means the transcript line won't survive restart.
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

  // Replay prior messages to the renderer so the chat comes up populated.
  // Send AFTER subscribing for deterministic ordering (history first,
  // then future events) — but BEFORE we return, so callers of
  // `ensureAiSession()` can assume the UI is primed once their await
  // resolves.
  if (priorMessages.length > 0) {
    safeSend(sender, 'ai:event', { type: 'deck:history_replay', messages: priorMessages })
    // Also emit a usage update so the status bar reflects the resumed
    // transcript immediately (not only after the next turn ends).
    emitContextUsage()
  }

  async function send(text: string): Promise<void> {
    try {
      // Re-resolve model + key + compaction settings on each send so the
      // user can change Settings mid-session and have the next message
      // pick it up.
      const settings = await getSettings()
      runtimeSettingsSnapshot = settings
      const model = buildModel({
        provider: settings.ai.provider,
        model: resolveModel(settings),
        custom: settings.ai.custom,
      })
      agent.state.model = model

      await agent.prompt(text)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      safeSend(sender, 'ai:event', { type: 'deck:fatal', error: message })
    }
  }

  function abort(): void {
    agent.abort()
  }

  /**
   * Ordering matters here:
   *
   *   1. If a run is active, abort and wait for it to settle. Otherwise
   *      its `agent_end` listener will call `persistAgentMessages` *after*
   *      we've started a fresh session, resurrecting stale messages onto
   *      a transcript the user just asked us to clear.
   *   2. Roll over to a new session file (see chats.ts::resetDeckSessionManager
   *      for why the old file is deleted instead of kept).
   *   3. Clear the Agent's in-memory state. Done last so any still-pending
   *      listener has already seen consistent state by the time it fires.
   *   4. Tell the renderer to drop its DOM.
   */
  async function reset(): Promise<void> {
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
      // Best effort — don't wait forever. If the run hangs, the window is
      // going away anyway.
      await Promise.race([agent.waitForIdle(), new Promise((r) => setTimeout(r, 500))])
    }
  }

  return { send, abort, reset, dispose }
}
