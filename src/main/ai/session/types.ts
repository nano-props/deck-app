import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core'
import type { WebContents } from 'electron'
import type { ProviderId } from '#/main/secrets.ts'
import type { DeckSessionRecord } from '#/main/ai/session-store.ts'

/**
 * Result of `send()`. Distinguishes "the user can retry, nothing went
 * wrong with the existing run" (`busy`) from "the run actually failed
 * and we surfaced a deck:fatal" (`error`). The renderer's IPC layer maps
 * `busy` to a benign `{ ok: false }` — we deliberately do NOT emit
 * deck:fatal in that case, because doing so would make the renderer's
 * still-running first turn look broken.
 */
export type SendResult = { ok: true } | { ok: false; reason: 'busy' | 'not-ready' | 'error'; message: string }

export interface ChatUiContext {
  lang: 'en' | 'zh' | 'ko'
  langPref: 'en' | 'zh' | 'ko' | 'auto'
  theme: 'light' | 'dark'
  themePref: 'light' | 'dark' | 'auto'
}

export interface DeckAiSession {
  send(text: string, uiContext?: ChatUiContext): Promise<SendResult>
  /** Abort the in-flight turn. Resolves once the agent settles, so a
   *  follow-up send won't race the still-shutting-down agent. */
  abort(): Promise<void>
  /** Discard the in-memory state of this session. Caller is responsible
   *  for spinning up a successor session (via the manager). */
  dispose(): Promise<void>
  /** The deck-level session record this adapter is bound to. The provider
   *  field is what the IPC layer uses to gate sends against a stale
   *  settings.ai.provider. Read-only from the caller's POV — adapters
   *  update it on disk via session-store. */
  getRecord(): DeckSessionRecord
}

/**
 * Extra `deck:*`-prefixed events we emit alongside pi-agent-core's
 * AgentEvents. Pulled out as a named union so backends that build their
 * own narrower event type (the CLI adapter doesn't reuse pi-agent's
 * AgentEvent because pi's AssistantMessage carries fields like
 * api/provider/model/usage that the CLI can't fill from stream-json)
 * can compose `DeckOnlyAiEvent` with their own `agent_*` / `message_*` /
 * `tool_*` mirrors instead of restating each `deck:*` shape inline —
 * which would silently drift when we add a new deck event.
 */
export type DeckOnlyAiEvent =
  | { type: 'deck:file_change'; path: string }
  | { type: 'deck:fatal'; error: string }
  | { type: 'deck:session_reset' }
  | {
      type: 'deck:session_bound'
      provider: ProviderId
      resumed: boolean
      resumeSurvivesReopen: boolean
      /** True when the session is a "best-effort placeholder" emitted
       *  alongside `deck:fatal` — the bind itself failed, but we send
       *  this so the renderer's `boundSession` doesn't stay null and
       *  the History button placeholder doesn't lock the toolbar. UI
       *  can use this flag to differentiate "no AI online (degraded)"
       *  from "AI online but Pack+CLI so no history". */
      degraded?: boolean
    }
  | { type: 'deck:history_replay'; messages: AgentMessage[] }
  | { type: 'deck:context_usage'; tokens: number; contextWindow: number }
  | { type: 'deck:context_warning'; tokens: number; contextWindow: number }

/**
 * Full event surface emitted on the `ai:event` IPC channel. pi-agent
 * backends produce `AgentEvent`s directly via `agent.subscribe`; the
 * `deck:*` half is layered on top by the session module / manager.
 *
 * Renderer mirror: `src/renderer/deck.d.ts:AiEvent`. The two should
 * stay in step — the deck-prefixed half is shared via DeckOnlyAiEvent
 * (export only; renderer can't import main types at runtime so the
 * union itself is restated, but kept structurally compatible).
 */
export type EditorAiEvent = AgentEvent | DeckOnlyAiEvent

export interface SessionParams {
  /**
   * WebContents we push AI events to — i.e. the chrome WebContentsView
   * hosting the renderer. Decoupled from the window so the session
   * module doesn't reach into AppWindow.
   */
  sender: WebContents
  rootDir: string
  /**
   * Whether this backend's resume key (if it has one) still refers to
   * a reachable transcript across deck reopens. False for Pack/preview
   * decks whose cwd is a per-open tmpdir — the Claude CLI hashes cwd
   * into its transcript path so a `--session-id` uuid we mint today
   * would be unreachable next time. The manager normalizes records
   * before binding, so adapters mostly observe this via a null
   * `providerSessionId` — but adapters that *write* history rows need
   * the explicit flag to know "no future bind can reach this row,
   * skip saveSession entirely."
   *
   * Always true for pi-agent backends (their transcripts live under
   * our userData dir keyed off chatKey, which is stable across
   * opens) — the pi-agent adapter currently ignores this field and
   * treats it as always true. The cwd-keyed CLI adapter is the only
   * consumer today; new cwd-keyed providers will need to read it.
   *
   * See `decideResumeStrategy` in resume-strategy.ts for the source
   * of truth on this decision.
   */
  resumeSurvivesReopen: boolean
  /**
   * Stable identity of the deck — the path the user opened (`.deck` file
   * for Packs, directory for Sources). Used to route chat history; pi
   * uses `rootDir` as the cwd written into session headers, but the
   * directory chats live in must survive across opens (a Pack's rootDir
   * is a fresh tmpdir every time).
   */
  chatKey: string
  /** Human-visible deck name, used in the system prompt. */
  deckName: string
  /**
   * Deck-level session this backend is binding to. Provider lock,
   * resume hint (providerSessionId), and on-disk identity all live
   * here. Adapters mutate it via session-store on first successful
   * turn / reset; callers see updates through `getRecord()`.
   */
  record: import('#/main/ai/session-store.ts').DeckSessionRecord
  /**
   * Called when the AI mutates a file under `rootDir`. Independent of
   * the chokidar watcher path: that route also fires markDirty, but
   * the watcher debounces (~120ms) and may merge a write+close pair
   * into a single event AFTER the deck has already been torn down. The
   * AI tool path runs synchronously from inside the agent loop, before
   * any teardown, so this guarantees `dirty` flips for AI-driven edits.
   */
  onMutation?: () => void
  /**
   * Snapshot the live deck preview as a PNG data URL. Wired to the
   * `screenshot_preview` tool so the agent can see what it just edited.
   * Returns null when the preview view isn't available (no deck loaded,
   * Play-only mode, view destroyed). The session module is decoupled
   * from AppWindow's preview internals — AppWindow injects this.
   */
  capturePreview?: () => Promise<{ dataUrl: string } | null>
}
