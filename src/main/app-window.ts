import { app, BaseWindow, dialog, nativeTheme, shell, WebContentsView, type WebContents } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { createDeckAiSession, type DeckAiSession } from '#/main/ai/session.ts'
import { appChrome, supportsOverlayThemeUpdates, initialOverlay, overlayForTheme } from '#/main/chrome-strategy.ts'
import { loadDeck } from '#/main/deck-loader.ts'
import { isEditable, type DeckContext, type DeckKind, type DeckManifest } from '#/main/deck-types.ts'
import { watchDeckSource, type DeckWatcher } from '#/main/deck-watcher.ts'
import { buildMenu } from '#/main/menu.ts'
import { startDeckServer } from '#/main/server.ts'
import { clampChatWidth, DEFAULT_CHAT_WIDTH, SPLITTER_PX, TOPBAR_PX } from '#/main/window-layout.ts'
import { findAppWindowByRootDir, registerAppWindow, unregisterAppWindow } from '#/main/window-registry.ts'

/**
 * Single-window application shell.
 *
 * Each `AppWindow` is a `BaseWindow` hosting two `WebContentsView`s:
 *   - `chromeView`  — our UI (launcher cards / editor chat / player exit
 *                     affordance), loaded from app.html. Always present.
 *   - `deckView`    — the Deck preview. Created on demand when a deck is
 *                     loaded, destroyed when the deck is closed.
 *
 * The window has a `mode` that the renderer reads to switch between
 * launcher / player / editor layouts. Mode transitions are driven by the
 * state transitions below:
 *
 *   launcher --openDeck--> player --enterEditor--> editor
 *   editor   --enterPlayer--> player
 *   player/editor --closeDeck--> launcher
 *
 * Mutual exclusion of the same deck across windows (terminology.md) is
 * enforced by `findAppWindowByRootDir` in this module.
 */

export const APP_ICON = app.isPackaged
  ? path.join(process.resourcesPath, 'assets', 'icon.png')
  : path.join(import.meta.dirname, '..', '..', 'assets', 'icon.png')

const CHROME_PRELOAD = path.join(import.meta.dirname, '..', 'preload', 'app-preload.js')
const CHROME_HTML = path.join(import.meta.dirname, '..', 'renderer', 'app.html')

// Layout constants + clamp helper live in `window-layout.ts`.

/**
 * Secure defaults shared by every view. Preload is overridden per-view.
 *
 * `sandbox` is deliberately NOT set here: the chromeView turns it off so
 * its preload can `require` npm modules (marked / dompurify for chat
 * Markdown rendering), while the deckView keeps it on. Both views still
 * have `contextIsolation: true` + `nodeIntegration: false`, so an XSS
 * in a deck page still can't reach Node.
 */
const sharedWebPreferences = {
  contextIsolation: true,
  nodeIntegration: false,
} as const

// Matches tokens.css --bg for each theme. BaseWindow + chromeView take
// this as their raw backing color so a freshly-shown window doesn't flash
// white before the renderer's CSS applies. `nativeTheme.shouldUseDarkColors`
// is our best guess at this moment — the renderer can still flip
// `data-theme` afterward if the user picked a non-auto preference.
function appCanvasBg(): string {
  return nativeTheme.shouldUseDarkColors ? '#0c0d0f' : '#f7f7f5'
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * Top-level mode: either the launcher (no deck) or a deck is open.
 * When a deck is open, a second axis — `subView` — picks between `play`
 * (preview only) and `edit` (chat + preview). The topbar stays mounted
 * across both sub-views so the user always has a clear way out.
 */
export type AppMode = 'launcher' | 'deck'
export type DeckSubView = 'play' | 'edit'

export interface AppState {
  mode: AppMode
  subView: DeckSubView
  deck: Pick<DeckContext, 'rootDir' | 'manifest' | 'kind' | 'deleteOnClose' | 'sourcePath'> | null
  chatWidth: number
  /** True while an openDeck flow is in flight (launcher → deck). */
  loading: boolean
  /** OS-level fullscreen state. In play sub-view this hides the topbar
   *  and expands deckView to fill the window for immersive presentation. */
  isFullScreen: boolean
}

interface AppWindowParams {
  initialChatWidth?: number
}

// ---------------------------------------------------------------------------
// AppWindow
// ---------------------------------------------------------------------------

export class AppWindow {
  private readonly win: BaseWindow
  private readonly chromeView: WebContentsView
  private readonly winId: number
  private readonly chromeWcId: number
  private deckView: WebContentsView | null = null
  private deck: DeckContext | null = null
  private aiSession: DeckAiSession | null = null
  private deckWatcher: DeckWatcher | null = null
  private mode: AppMode = 'launcher'
  private subView: DeckSubView = 'edit'
  private chatWidth: number
  private loading = false
  private isFullScreen = false
  private disposed = false

  constructor(params: AppWindowParams = {}) {
    this.chatWidth = params.initialChatWidth ?? DEFAULT_CHAT_WIDTH

    this.win = new BaseWindow({
      // Show immediately (default). `backgroundColor: appCanvasBg()`
      // paints the CALayer behind any web content, so the user sees the
      // themed canvas the instant the window appears — no "click did
      // nothing" gap while the renderer boots. A few ms of NSWindow
      // default-white may still flash on macOS before the CALayer
      // composites; that's a documented limitation of BaseWindow (no
      // equivalent to BrowserWindow's `ready-to-show`) and the
      // responsiveness win outweighs it.
      titleBarStyle: appChrome.titleBarStyle,
      titleBarOverlay: appChrome.initialOverlay(),
      // Center macOS traffic lights vertically in our 32px topbar. Default
      // Electron offset targets the 28px native bar; at 32px the lights
      // sit too high. y = (TOPBAR_PX - lightDiameter) / 2 = (32 - 12) / 2.
      // x matches the Electron/Safari default (~12-20px from left).
      trafficLightPosition: { x: 16, y: (TOPBAR_PX - 12) / 2 },
      width: 1280,
      height: 820,
      minWidth: 960,
      minHeight: 600,
      title: 'Deck',
      icon: APP_ICON,
      backgroundColor: appCanvasBg(),
    })

    // Win/Linux: suppress the native menu bar entirely. The app menu is
    // rendered in-window by src/renderer/ui/menu.js; the native Menu is
    // still installed (see menu.ts::buildMenu) so accelerators bind
    // globally. `autoHideMenuBar: true` would still pop the bar on Alt,
    // which we don't want now that there's a visible replacement.
    if (appChrome.hideNativeMenuBar) this.win.setMenuBarVisibility(false)

    this.chromeView = new WebContentsView({
      webPreferences: {
        ...sharedWebPreferences,
        preload: CHROME_PRELOAD,
        // Off here so the preload can `require` npm packages (marked /
        // dompurify). Renderer code remains isolated by `contextIsolation`
        // + the contextBridge surface defined in app-preload.js — it
        // cannot directly call require.
        sandbox: false,
      },
    })
    this.chromeView.setBackgroundColor(appCanvasBg())
    this.win.contentView.addChildView(this.chromeView)

    this.winId = this.win.id
    this.chromeWcId = this.chromeView.webContents.id
    registerAppWindow(this, { windowId: this.winId, chromeWcId: this.chromeWcId })

    // Re-layout on every window resize (and on mode transitions from
    // within this class). We listen to 'resize' rather than 'resized' so
    // the deckView tracks the window border without visible lag.
    this.win.on('resize', () => this.applyLayout())

    // Fullscreen: in play sub-view we hide the topbar and stretch the
    // deckView to fill the window. The chromeView still renders the
    // (now hidden) topbar HTML; CSS keys off `body[data-fullscreen]`.
    const onFullScreenChange = (value: boolean) => {
      this.isFullScreen = value
      this.applyLayout()
      this.broadcastState()
    }
    this.win.on('enter-full-screen', () => onFullScreenChange(true))
    this.win.on('leave-full-screen', () => onFullScreenChange(false))

    // Menu items gate on the focused window's deck state (see
    // canExportCurrentDeck in menu.ts), so rebuild when focus shifts
    // between our windows.
    this.win.on('focus', () => buildMenu())

    // `handleClosed` is async; swallow any rejection so an unexpected
    // throw can't surface as Electron's "uncaught exception" dialog. The
    // map-cleanup inside is already guarded to always run.
    this.win.once('closed', () => {
      this.handleClosed().catch((err) => {
        console.error('[AppWindow] handleClosed failed', err)
      })
    })

    // Load the chrome UI. `loadFile` is async but we don't need to await
    // — renderer requests the current state via IPC on DOMContentLoaded.
    void this.chromeView.webContents.loadFile(CHROME_HTML)

    this.applyLayout()
  }

  // ---- Introspection ------------------------------------------------------

  get id(): number {
    return this.winId
  }

  getBaseWindow(): BaseWindow {
    return this.win
  }

  getChromeWebContents(): WebContents {
    return this.chromeView.webContents
  }

  getMode(): AppMode {
    return this.mode
  }

  getSubView(): DeckSubView {
    return this.subView
  }

  getDeck(): DeckContext | null {
    return this.deck
  }

  getAiSession(): DeckAiSession | null {
    return this.aiSession
  }

  getState(): AppState {
    return {
      mode: this.mode,
      subView: this.subView,
      deck: this.deck
        ? {
            rootDir: this.deck.rootDir,
            manifest: this.deck.manifest,
            kind: this.deck.kind,
            deleteOnClose: this.deck.deleteOnClose,
            sourcePath: this.deck.sourcePath,
          }
        : null,
      chatWidth: this.chatWidth,
      loading: this.loading,
      isFullScreen: this.isFullScreen,
    }
  }

  focus(): void {
    if (this.win.isDestroyed()) return
    if (this.win.isMinimized()) this.win.restore()
    this.win.focus()
  }

  // ---- Mode transitions ---------------------------------------------------

  /**
   * Load `deckPath` (a `.deck` file or a Deck Source directory) and switch
   * the window into deck mode.
   *
   * `preferredSubView` picks the default sub-view:
   *   - 'auto' (default): Deck Pack → play, Deck Source → edit.
   *   - 'play' / 'edit':  explicit override (menu action, user pick).
   *
   * Broadcasts a `loading: true` state while unpacking / starting the
   * server so the launcher renderer can show a spinner (fix for the
   * "click Open, nothing visible" UX).
   */
  async openDeck(
    deckPath: string,
    preferredSubView: DeckSubView | 'auto' = 'auto',
    dirKind: 'source' | 'workspace' = 'source',
  ): Promise<boolean> {
    let loaded: { rootDir: string; manifest: DeckManifest; kind: DeckKind; deleteOnClose: boolean } | null = null

    this.loading = true
    this.broadcastState()

    try {
      if (this.deck) await this.closeDeck()

      loaded = await loadDeck(deckPath, dirKind)

      // Mutual exclusion: another window has this deck open. Focus it
      // and throw away any temp extraction we just produced.
      const existing = findAppWindowByRootDir(loaded.rootDir)
      if (existing && existing !== this) {
        if (loaded.deleteOnClose) {
          await rm(loaded.rootDir, { recursive: true, force: true }).catch(() => {})
        }
        existing.focus()
        this.loading = false
        this.broadcastState()
        return false
      }

      const server = await startDeckServer(loaded.rootDir)

      this.deck = {
        rootDir: loaded.rootDir,
        manifest: loaded.manifest,
        kind: loaded.kind,
        deleteOnClose: loaded.deleteOnClose,
        sourcePath: deckPath,
        server,
      }
      this.win.setTitle(loaded.manifest.name)

      // Pick default sub-view. Packs are distribution artifacts — land in
      // Play. Sources / workspaces are authoring artifacts — land in Edit.
      // Override via `preferredSubView` when the caller knows better
      // (e.g. menu's "Edit Deck" action).
      const editable = isEditable(loaded.kind)
      const sub: DeckSubView = preferredSubView === 'auto' ? (editable ? 'edit' : 'play') : preferredSubView

      // Packs can't be edited directly; fall back to Play if the caller
      // (or the auto rule) picked edit for a Pack.
      const finalSub: DeckSubView = sub === 'edit' && !editable ? 'play' : sub

      await this.enterDeckMode(finalSub)
      this.loading = false
      this.broadcastState()
      return true
    } catch (err) {
      // Clean up a temp extraction that was produced but not yet adopted.
      if (loaded?.deleteOnClose && !this.deck) {
        await rm(loaded.rootDir, { recursive: true, force: true }).catch(() => {})
      }
      this.loading = false
      this.broadcastState()
      const message = err instanceof Error ? err.message : String(err)
      void dialog.showMessageBox({
        type: 'error',
        title: 'Failed to open deck',
        message: 'Failed to open deck',
        detail: `${message}\n\nPath: ${deckPath}`,
      })
      return false
    }
  }

  /**
   * Tear down the current deck — stop its server, delete its temp extraction
   * if we owned it, drop the deckView, and return to launcher mode.
   * Idempotent: no-op if no deck is loaded.
   */
  async closeDeck(): Promise<void> {
    if (!this.deck) return
    const deck = this.deck
    this.deck = null

    await this.teardownDeckWatcher()
    await this.teardownAiSession()
    this.teardownDeckView()

    await deck.server.close().catch(() => {})
    if (deck.deleteOnClose) {
      await rm(deck.rootDir, { recursive: true, force: true }).catch(() => {})
    }

    // The awaits above yield to the event loop — the window may have
    // been closed in the meantime. Further window mutations would throw
    // and leave cleanup half-done.
    if (this.win.isDestroyed()) return

    this.win.setTitle('Deck')
    this.mode = 'launcher'
    this.subView = 'edit' // reset so re-opening defaults cleanly
    this.applyChromeOverlay()
    this.applyLayout()
    this.broadcastState()
  }

  /** Switch sub-view. The AI session is tied to the deck's lifetime, not
   *  the sub-view — flipping to Play and back must NOT lose the chat
   *  transcript or abort a streaming turn. Session creation/teardown
   *  happens in `enterDeckMode` / `closeDeck` / `handleClosed` only.
   *  Refused (with a dialog) if the caller asked for Edit on a Pack —
   *  Packs are read-only; the menu/IPC "Edit" path routes them through
   *  unpackAndOpenInEditor instead of flipping sub-view.
   *
   *  deckView is a native WebContentsView that sits above all DOM, so
   *  a DOM-level fade mask cannot hide it repositioning. We hide the
   *  view itself during the transition: the renderer's fade mask
   *  covers the DOM crossfade, and while the mask is opaque the
   *  deckView is invisible — no "jump" visible to the user. */
  async setSubView(next: DeckSubView): Promise<void> {
    if (this.mode !== 'deck' || !this.deck) return
    if (next === 'edit' && !isEditable(this.deck.kind)) {
      void dialog.showMessageBox({
        type: 'info',
        title: "Can't edit a packed deck",
        message: 'Unpack the .deck file first',
        detail: 'The Editor only edits an unpacked Deck Source directory.',
      })
      return
    }
    if (this.subView === next) return

    // Hide deckView for the duration of the crossfade. Only do this
    // when a deckView exists — in the launcher → deck path the view
    // is created later in this method chain.
    const hideDeckView = !!this.deckView && !this.deckView.webContents.isDestroyed()
    if (hideDeckView) this.deckView!.setVisible(false)

    this.subView = next
    this.applyChromeOverlay()
    this.applyLayout({ preserveVisibility: hideDeckView })
    this.broadcastState()

    if (hideDeckView) {
      // Give the new bounds a frame to take effect before showing the
      // view again — otherwise it flashes in the OLD position for one
      // paint. 80ms is conservative but well under a perceivable pause.
      await new Promise((r) => setTimeout(r, 80))
      if (!this.deckView || this.deckView.webContents.isDestroyed()) return
      this.deckView.setVisible(true)
    }
  }

  /** Convenience — equivalent to `setSubView('edit')`. */
  enterEditor(): Promise<void> {
    return this.setSubView('edit')
  }

  /** Convenience — equivalent to `setSubView('play')`. */
  enterPlayer(): Promise<void> {
    return this.setSubView('play')
  }

  /** Reload the current deck preview. */
  reloadDeck(ignoreCache = false): void {
    if (!this.deckView || this.deckView.webContents.isDestroyed()) return
    if (ignoreCache) {
      this.deckView.webContents.reloadIgnoringCache()
    } else {
      // Re-loadURL with a cache-bust; reload() would hit Chromium's
      // in-memory cache and miss freshly-written AI edits.
      if (!this.deck) return
      const bust = `_=${Date.now().toString(36)}`
      const serverUrl = this.deck.server.url
      const url = serverUrl + (serverUrl.includes('?') ? '&' : '?') + bust
      void this.deckView.webContents.loadURL(url)
    }
  }

  setChatWidth(px: number): void {
    if (!Number.isFinite(px)) return
    this.chatWidth = px
    if (this.mode === 'deck' && this.subView === 'edit') this.applyLayout()
  }

  /**
   * Hide the deckView so DOM overlays rendered in the chromeView (e.g.
   * the Settings modal) can cover the full window instead of being
   * clipped by the deckView above them.
   *
   * Cross-WebContentsView layering is set by child-view order, not CSS
   * z-index — the deckView is always on top of chromeView where their
   * bounds overlap. Toggling visibility off is the cheap fix.
   */
  setDeckViewVisible(visible: boolean): void {
    if (!this.deckView || this.deckView.webContents.isDestroyed()) return
    // Only toggle when we're actually showing a deck; launcher has no
    // deckView and nothing to hide.
    if (this.mode !== 'deck') return
    this.deckView.setVisible(visible)
  }

  applyChromeTheme(theme: 'dark' | 'light'): void {
    if (!supportsOverlayThemeUpdates || this.win.isDestroyed()) return
    // With persistent chrome (48px topbar always visible), the deck
    // preview never touches the top 32px region, so one overlay per
    // theme is enough — no need for a separate player-mode tint.
    try {
      this.win.setTitleBarOverlay(overlayForTheme(theme === 'dark'))
    } catch {
      // Not created with titleBarStyle: 'hidden' — safe to ignore.
    }
  }

  // ---- Internals ----------------------------------------------------------

  private broadcastState(): void {
    if (this.chromeView.webContents.isDestroyed()) return
    this.chromeView.webContents.send('app:state', this.getState())
    // Rebuild the application menu so items that gate on deck shape
    // (e.g. Export as .deck, which disables on Packs and on the launcher)
    // reflect the new state. The menu is global, so this is safe even if
    // the broadcast is for a non-focused window — the next focus change
    // will rebuild again via focusedAppWindow().
    buildMenu()
  }

  /** Re-apply the title-bar overlay for the current mode. Persistent
   *  chrome means this is just the theme overlay — kept as a method so
   *  future per-mode variations have one place to land. */
  private applyChromeOverlay(): void {
    if (!supportsOverlayThemeUpdates || this.win.isDestroyed()) return
    try {
      this.win.setTitleBarOverlay(initialOverlay())
    } catch {
      // ignore
    }
  }

  /** Enter deck mode at `subView`. Ensures server-backed deckView and,
   *  for any editable deck (Source or Workspace), the AI session. Session
   *  lifetime is tied to the deck, not the sub-view — Play ↔ Edit flips
   *  don't touch it. Teardown is symmetric on closeDeck. */
  private async enterDeckMode(subView: DeckSubView): Promise<void> {
    this.mode = 'deck'
    this.subView = subView
    this.ensureDeckView()
    // Packs can't be edited; we never create a session for them because
    // the rootDir is a throwaway temp extraction and any AI-written files
    // would be lost on closeDeck. Editable decks (Source / Workspace)
    // always get a session (even in Play sub-view) so switching to Edit
    // is instant and carries the full transcript.
    if (this.deck && isEditable(this.deck.kind)) {
      await this.ensureAiSession()
      this.ensureDeckWatcher()
    } else {
      await this.teardownAiSession()
      await this.teardownDeckWatcher()
    }
    this.applyChromeOverlay()
    // Preserve visibility: ensureDeckView hides a freshly-created deckView
    // until its first paint. Default applyLayout would force it visible
    // again and we'd see the black/themed background flash.
    this.applyLayout({ preserveVisibility: true })
    this.broadcastState()
  }

  private ensureDeckView(): void {
    if (this.deckView || !this.deck) return
    // deckView hosts untrusted deck HTML — keep sandbox on. No preload,
    // so the deck page can't reach `ipcRenderer` regardless; sandbox
    // adds the Chromium process-level isolation as defense in depth.
    // Leave the view's background transparent — no setBackgroundColor
    // call. The prior '#000000' was what produced the black flash on
    // cold open. With transparent, the chromeView's themed canvas shows
    // through during the pre-paint gap. Deck authors are responsible
    // for setting their own <body> background.
    const view = new WebContentsView({ webPreferences: { ...sharedWebPreferences, sandbox: true } })
    // Hide until the deck's first frame renders. Without this, some
    // platforms briefly composite the empty view as pure transparent,
    // which can read as a flash if the underlying chromeView hasn't
    // laid out the preview pane yet.
    view.setVisible(false)
    const reveal = () => {
      if (!this.deckView || this.deckView !== view) return
      if (view.webContents.isDestroyed()) return
      if (this.mode === 'deck') view.setVisible(true)
    }
    view.webContents.once('did-finish-load', reveal)
    view.webContents.once('did-fail-load', reveal)

    const serverOrigin = new URL(this.deck.server.url).origin

    // Lock navigation to our server, route external links to the OS browser.
    view.webContents.on('will-navigate', (event, url) => {
      try {
        if (new URL(url).origin !== serverOrigin) event.preventDefault()
      } catch {
        event.preventDefault()
      }
    })
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http://') || url.startsWith('https://')) {
        void shell.openExternal(url)
      }
      return { action: 'deny' }
    })

    // Default-deny permissions. Fullscreen is allowed because Decks
    // benefit from F11 presentation. Future clipboard/camera/mic surface
    // widens here.
    view.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'fullscreen')
    })

    this.win.contentView.addChildView(view)
    this.deckView = view

    void view.webContents.loadURL(this.deck.server.url)
  }

  private teardownDeckView(): void {
    if (!this.deckView) return
    const view = this.deckView
    this.deckView = null
    try {
      this.win.contentView.removeChildView(view)
    } catch {
      // already removed
    }
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  private async ensureAiSession(): Promise<void> {
    if (this.aiSession || !this.deck) return
    // Wait for the chrome renderer to finish loading before we construct
    // the session. Session construction can emit `deck:history_replay`
    // synchronously (when there's a prior transcript on disk), and if the
    // renderer hasn't registered its `ai:event` listener yet that message
    // is lost. On cold start (double-click a .deck), chromeView.loadFile
    // races deck extraction — a warm filesystem cache can win the race.
    await this.whenChromeReady()
    this.aiSession = await createDeckAiSession({
      sender: this.chromeView.webContents,
      rootDir: this.deck.rootDir,
      deckName: this.deck.manifest.name,
    })
  }

  /**
   * Resolve when chromeView has finished its initial load. Uses
   * `webContents.isLoading()` as the fast path, `did-finish-load` as the
   * slow path. Safe after disposal — resolves immediately if the view is
   * already destroyed (the caller bails on the null deck check right
   * after).
   */
  private whenChromeReady(): Promise<void> {
    const wc = this.chromeView.webContents
    if (wc.isDestroyed()) return Promise.resolve()
    if (!wc.isLoading()) return Promise.resolve()
    return new Promise((resolve) => {
      const onLoad = () => {
        wc.off('did-finish-load', onLoad)
        wc.off('did-fail-load', onLoad)
        resolve()
      }
      wc.once('did-finish-load', onLoad)
      wc.once('did-fail-load', onLoad)
    })
  }

  private async teardownAiSession(): Promise<void> {
    if (!this.aiSession) return
    const s = this.aiSession
    this.aiSession = null
    await s.dispose().catch(() => {})
  }

  /**
   * Watch the Deck Source for out-of-band edits (user's own editor, file
   * manager drops, git operations). A change triggers a preview reload.
   * Only meaningful for editable decks — Packs are read-only temp
   * extractions, so there's nothing useful to observe there.
   *
   * AI tool writes already reload the preview via chat.js's `agent_end`
   * → `reloadPreview` path; the watcher doubles up for those, but the
   * built-in debounce keeps it to one reload per burst.
   */
  private ensureDeckWatcher(): void {
    if (this.deckWatcher || !this.deck) return
    if (!isEditable(this.deck.kind)) return
    this.deckWatcher = watchDeckSource(this.deck.rootDir, () => {
      if (this.win.isDestroyed()) return
      if (!this.deck) return
      this.reloadDeck(false)
    })
  }

  private async teardownDeckWatcher(): Promise<void> {
    if (!this.deckWatcher) return
    const w = this.deckWatcher
    this.deckWatcher = null
    await w.close().catch(() => {})
  }

  /**
   * Position the two WebContentsViews based on current mode/sub-view.
   *
   * Persistent chrome layout: the 48px topbar is always visible (rendered
   * by chromeView). deckView lives below it.
   *
   * - launcher:       chromeView full; deckView absent.
   * - deck, play:     chromeView full; deckView below topbar, full width.
   * - deck, edit:     chromeView full; deckView below topbar, right of
   *                   the chat column.
   */
  private applyLayout({ preserveVisibility = false }: { preserveVisibility?: boolean } = {}): void {
    if (this.win.isDestroyed()) return
    const [w, h] = this.win.getContentSize()
    this.chromeView.setBounds({ x: 0, y: 0, width: w, height: h })

    if (!this.deckView) return

    if (this.mode !== 'deck') {
      this.deckView.setVisible(false)
      return
    }

    if (!preserveVisibility) this.deckView.setVisible(true)
    if (this.subView === 'play') {
      // Fullscreen play: hide topbar by stretching deckView over it.
      // Edit mode keeps the topbar even in fullscreen (editing tools
      // remain useful).
      const topOffset = this.isFullScreen ? 0 : TOPBAR_PX
      this.deckView.setBounds({
        x: 0,
        y: topOffset,
        width: w,
        height: Math.max(0, h - topOffset),
      })
    } else {
      const chat = this.clampChatWidth(this.chatWidth)
      const x = Math.round(chat) + SPLITTER_PX
      this.deckView.setBounds({
        x,
        y: TOPBAR_PX,
        width: Math.max(0, w - x),
        height: Math.max(0, h - TOPBAR_PX),
      })
    }
  }

  private clampChatWidth(px: number): number {
    if (this.win.isDestroyed()) return px
    const [w] = this.win.getContentSize()
    return clampChatWidth(px, w)
  }

  private async handleClosed(): Promise<void> {
    if (this.disposed) return
    this.disposed = true

    // Drop registry entries first, before any resource cleanup that
    // could throw. If the map isn't cleaned, `activate` sees a stale
    // entry and the dock-click "open a launcher" path never fires.
    // Use cached ids — `this.win` / `this.chromeView.webContents` are
    // already destroyed by the time `closed` fires, so their `.id`
    // getters throw "Object has been destroyed".
    unregisterAppWindow({ windowId: this.winId, chromeWcId: this.chromeWcId })

    // Clean up in-flight deck if any. teardownDeckView /
    // teardownAiSession aren't called here — their WebContentsViews are
    // already destroyed with the window; we just release the backing
    // resources (AI session, HTTP server, temp extraction).
    if (this.deck) {
      const deck = this.deck
      this.deck = null
      if (this.deckWatcher) {
        const w = this.deckWatcher
        this.deckWatcher = null
        await w.close().catch(() => {})
      }
      if (this.aiSession) {
        const s = this.aiSession
        this.aiSession = null
        await s.dispose().catch(() => {})
      }
      await deck.server.close().catch(() => {})
      if (deck.deleteOnClose) {
        await rm(deck.rootDir, { recursive: true, force: true }).catch(() => {})
      }
    }
  }

  close(): void {
    if (!this.win.isDestroyed()) this.win.close()
  }

  isDestroyed(): boolean {
    return this.win.isDestroyed()
  }
}

/** Does a path look like a deck (file .deck or dir with deck.json)? */
export function isDeckPath(p: string): 'file' | 'dir' | null {
  try {
    const resolved = path.resolve(p)
    if (!existsSync(resolved)) return null
    const s = statSync(resolved)
    if (s.isFile() && resolved.toLowerCase().endsWith('.deck')) return 'file'
    if (s.isDirectory() && existsSync(path.join(resolved, 'deck.json'))) return 'dir'
  } catch {
    // not a real path
  }
  return null
}
