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
  /** Toggle the deck WebContentsView's visibility. The deckView paints
   *  above the chromeView in layer order, so DOM modals in the chrome get
   *  clipped where they overlap. Hide it for the lifetime of a modal
   *  overlay (Settings, future dialogs); show it again on close. */
  setDeckViewVisible: (visible: boolean) => Promise<void>
  /** Snapshot the current deckView frame plus the bounds it's painted
   *  at. Returns null when there's no deck mounted yet. The renderer
   *  draws an <img> at this rect under modal overlays so a translucent
   *  mask shows the deck through it instead of the empty chrome bg. */
  captureDeckView: () => Promise<{ dataUrl: string; rect: { x: number; y: number; width: number; height: number } } | null>
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
  setChromeTheme: (theme: 'light' | 'dark') => Promise<void>

  // ---- AI chat --------
  // `reason` distinguishes recoverable refusals (busy / not-ready) from
  // genuine run failures (error). The Composer uses it to decide whether
  // to roll back the optimistic chat-list append.
  aiSend: (
    text: string,
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
  pickAttachments: () => Promise<{ ok: boolean; files: { path: string; name: string; size: number; mimeType: string }[] }>
  pathForDroppedFile: (file: File) => string
  onAiEvent: (cb: (ev: AiEvent) => void) => () => void

  // ---- Markdown / external links --------
  renderMarkdown: (md: string) => string
  openExternal: (url: string) => void

  // ---- Settings open signal --------
  onOpenSettings: (cb: () => void) => () => void

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
    onChange: (
      cb: (payload: { lang: Lang; pref: LangPref; dict: Record<DictKey, string> }) => void,
    ) => () => void
  }

  // ---- Settings overlay --------
  settings: {
    load: () => Promise<Settings>
    save: (patch: Partial<Settings>) => Promise<Settings>
    listConfiguredProviders: () => Promise<Record<ProviderId, boolean>>
    setApiKey: (provider: ProviderId, key: string) => Promise<void>
    clearApiKey: (provider: ProviderId) => Promise<void>
    encryptionAvailable: () => Promise<boolean>
    ping: () => Promise<{ ok: boolean; text?: string; error?: string; provider?: ProviderId; model?: string }>
    aiReadiness: () => Promise<AiReadiness>
    bashAvailable: () => Promise<boolean>
  }
}

// ---- AI event union — kept loose; per-message routing happens in chat-events ---

export type AiEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end' }
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
}

export {}
