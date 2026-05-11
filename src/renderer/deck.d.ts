// Type surface for `window.deck` — the contextBridge bundle exposed by
// src/preload/app-preload.js. Hand-written rather than generated; the
// shape changes rarely and the preload itself is plain JS.

import type { DictKey } from '#/main/i18n/en.ts'
import type { AiSettings, Settings } from '#/main/settings.ts'
import type { ProviderId } from '#/main/secrets.ts'
import type { Lang, LangPref } from '#/main/i18n/index.ts'
import type { AiReadiness } from '#/main/ai/provider.ts'
import type { DeckChatSummary } from '#/main/chats.ts'
import type { MenuActionId, MenuNode } from '#/main/menu/index.ts'
import type { AppState } from '#/main/app-window/index.ts'
import type { ChatUiContext } from '#/main/ai/session/types.ts'
import type { ThemePref, ThemeState } from '#/main/theme.ts'

// ---- App / window state -----------------------------------------------------

interface DeckBridge {
  // ---- App state --------
  getState: () => Promise<AppState | null>
  onState: (cb: (state: AppState) => void) => () => void
  newWindow: () => Promise<void>

  // ---- Deck lifecycle --------
  openDialog: () => Promise<void>
  openPath: (p: string) => Promise<void>
  openDroppedFile: (file: File) => Promise<void>
  newDeck: () => Promise<void>
  closeDeck: () => Promise<void>
  enterEditor: () => Promise<void>
  enterPlayer: () => Promise<void>
  reloadPreview: () => Promise<void>
  saveDeck: () => Promise<void>
  saveDeckAs: () => Promise<void>
  setPreviewBounds: (rect: { x: number; y: number; width: number; height: number }) => Promise<void>
  /** Snapshot the current deckView frame plus the bounds it's painted
   *  at. Returns null when there's no deck mounted yet. Used by AI tool
   *  runs that include a preview image in the chat. */
  captureDeckView: () => Promise<{
    dataUrl: string
    rect: { x: number; y: number; width: number; height: number }
  } | null>
  /** Toggle the focused window's native fullscreen state. Mirrors the
   *  View → Toggle Full Screen menu item. Topbar stays visible. */
  toggleFullScreen: () => Promise<void>
  /** Toggle HTML5 fullscreen on the deck WebContents — same path Chrome
   *  uses for `requestFullscreen()`. Used by the Player topbar's
   *  Maximize button. Esc / clicking again exits. Pairs the OS window
   *  fullscreen automatically (main-side listener) so the titlebar also
   *  hides. */
  togglePresentation: () => Promise<void>

  // ---- Recents --------
  listRecents: () => Promise<{ path: string; name: string; openedAt: number }[]>
  forgetRecent: (p: string) => Promise<void>

  // ---- Theme --------
  // Mirrors the i18n shape: pull the active state on boot, push user
  // picks via `setPref`, subscribe to cross-window updates via
  // `onChange`. Persistence and OS-appearance subscription live in main.
  theme: {
    get: () => Promise<ThemeState>
    setPref: (pref: ThemePref) => Promise<ThemeState>
    onChange: (cb: (payload: ThemeState) => void) => () => void
  }

  // ---- AI chat --------
  // `reason` distinguishes recoverable refusals (busy / not-ready) from
  // genuine run failures (error). The Composer uses it to decide whether
  // to roll back the optimistic chat-list append.
  aiSend: (
    text: string,
    uiContext?: ChatUiContext,
  ) => Promise<{ ok: true } | { ok: false; reason: 'busy' | 'not-ready' | 'error' | 'no-session'; error: string }>
  aiAbort: () => Promise<void>
  aiReset: () => Promise<void>

  // ---- Chat history switcher --------
  chats: {
    /** `activePath` is the session file path the AI session currently
     *  writes to (or `null` when pi hasn't flushed yet). The popover uses
     *  it to mark the active row without round-tripping a separate IPC. */
    list: () => Promise<{ sessions: DeckChatSummary[]; activePath: string | null }>
    switch: (sessionPath: string) => Promise<{ ok: boolean }>
    delete: (sessionPath: string) => Promise<{ ok: boolean }>
  }

  // ---- Attachments --------
  attachAssets: (
    inputs: Array<
      | { kind: 'path'; path: string; mimeType?: string }
      | { kind: 'bytes'; fileName: string; mimeType: string; base64: string }
    >,
  ) => Promise<{
    ok: boolean
    /** Files that were copied to <rootDir>/assets/. Composer turns
     *  this into an `<attached_files>` block prepended to the user's
     *  prompt so the agent sees the relative paths. */
    staged?: { relPath: string; bytes: number; mimeType: string }[]
    rejected?: { name: string; reason: string }[]
    error?: string
  }>
  pickAttachments: () => Promise<{
    ok: boolean
    files: { path: string; name: string; size: number; mimeType: string }[]
  }>
  pathForDroppedFile: (file: File) => string
  onAiEvent: (cb: (ev: AiEvent) => void) => () => void

  // ---- Markdown / external links --------
  renderMarkdown: (md: string) => string
  openExternal: (url: string) => void

  // ---- Settings window --------
  /** Open the standalone Settings window (or focus + switch tab if it's
   *  already open). */
  openSettingsWindow: (tab?: 'appearance' | 'ai' | 'about') => Promise<void>
  /** Settings-window only — main pushes a tab id when the user re-invokes
   *  openSettingsWindow with a different tab while the window is open. */
  onSettingsWindowSetTab: (cb: (tab: 'appearance' | 'ai' | 'about') => void) => () => void
  /** Re-probe AI readiness after the Settings window closes. */
  onAiReadinessRefresh: (cb: () => void) => () => void
  /** Settings-window only: main asks the renderer to commit any pending
   *  edits before close. The handler should await every registered
   *  flusher (see lib/flush-registry.ts) and resolve to its aggregate
   *  FlushResult; preload forwards the result to main so a failed
   *  keychain write can prompt the user. Returns an unsubscribe
   *  function. */
  onFlushRequest: (
    handler: () => Promise<{ ok: boolean; errors: string[] }>,
  ) => () => void
  /** Settings-window only: signal main that the React tree has mounted
   *  and tab-level flushers have registered. Closes the race between
   *  `did-finish-load` and React's first commit. */
  notifySettingsWindowReady: () => void

  // ---- App menu --------
  menu: {
    get: () => Promise<MenuNode[]>
    onChange: (cb: (tree: MenuNode[]) => void) => () => void
    invoke: (id: MenuActionId) => Promise<void>
  }

  // ---- i18n --------
  i18n: {
    get: () => Promise<{ lang: Lang; pref: LangPref; dict: Record<DictKey, string> }>
    setPref: (pref: LangPref) => Promise<{ lang: Lang; pref: LangPref; dict: Record<DictKey, string> }>
    onChange: (cb: (payload: { lang: Lang; pref: LangPref; dict: Record<DictKey, string> }) => void) => () => void
  }

  // ---- Settings overlay --------
  settings: {
    load: () => Promise<Settings>
    save: (patch: Partial<Settings>) => Promise<Settings>
    listConfiguredProviders: () => Promise<Record<ProviderId, boolean>>
    setApiKey: (provider: ProviderId, key: string) => Promise<void>
    clearApiKey: (provider: ProviderId) => Promise<void>
    encryptionAvailable: () => Promise<boolean>
    ping: (overrides?: {
      provider?: ProviderId
      model?: string
      apiKey?: string
      custom?: Partial<
        Record<'custom-openai' | 'custom-anthropic' | 'custom-responses', { baseUrl: string; model: string }>
      >
    }) => Promise<{ ok: boolean; text?: string; error?: string; provider?: ProviderId; model?: string }>
    aiReadiness: () => Promise<AiReadiness>
  }
}

// ---- AI event union — kept loose; per-message routing happens in chat-events ---

export type AiEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages: AssistantMessageRef[] }
  | { type: 'message_start'; message: AssistantMessageRef }
  | { type: 'message_update'; message: AssistantMessageRef }
  | { type: 'message_end'; message: AssistantMessageRef }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_execution_end'; toolCallId: string; result: unknown; isError?: boolean }
  | { type: 'deck:file_change'; path: string }
  | { type: 'deck:fatal'; error: string }
  | { type: 'deck:history_replay'; messages: HistoryMessage[] }
  | { type: 'deck:session_reset' }
  | { type: 'deck:context_usage'; tokens: number; contextWindow: number }
  | { type: 'deck:context_warning'; tokens: number; contextWindow: number }

// We keep these shapes loose — they come from pi-agent-core / pi-coding-agent
// and we only consume a few fields.
export interface AssistantMessageRef {
  role?: string
  timestamp?: number
  content?: unknown
  stopReason?: string
  errorMessage?: string
}

export interface HistoryMessage {
  role?: string
  content?: unknown
  toolCallId?: string
  isError?: boolean
  stopReason?: string
  errorMessage?: string
}

declare global {
  interface Window {
    deck: DeckBridge
  }
  // Injected by Vite's `define` from package.json at build time.
  const __APP_VERSION__: string
  // Injected by Vite's `define` at build time. `commit` may be empty if the
  // build host has no git available; About tab handles that gracefully.
  const __BUILD_INFO__: {
    commit: string
    electron: string
    builtAt: string
  }
}

export {}
