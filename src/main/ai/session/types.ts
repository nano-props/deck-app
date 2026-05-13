import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core'
import type { WebContents } from 'electron'
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
 * Extra events we emit alongside pi-agent-core's AgentEvents. Kept on
 * the same IPC channel so the renderer only needs one listener.
 *
 * Our event `type`s are prefixed `deck:` so they cannot collide with
 * anything pi-agent-core might add (all its types are `agent_*` /
 * `turn_*` / `message_*` / `tool_execution_*`).
 */
export type EditorAiEvent =
  | AgentEvent
  | { type: 'deck:file_change'; path: string }
  | { type: 'deck:fatal'; error: string }
  | { type: 'deck:session_reset' }
  | { type: 'deck:history_replay'; messages: AgentMessage[] }
  | { type: 'deck:context_usage'; tokens: number; contextWindow: number }
  | { type: 'deck:context_warning'; tokens: number; contextWindow: number }

export interface SessionParams {
  /**
   * WebContents we push AI events to — i.e. the chrome WebContentsView
   * hosting the renderer. Decoupled from the window so the session
   * module doesn't reach into AppWindow.
   */
  sender: WebContents
  rootDir: string
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
