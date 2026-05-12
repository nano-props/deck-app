import { BaseWindow, dialog, WebContentsView, type WebContents } from 'electron'
import { copyFile } from 'node:fs/promises'
import path from 'node:path'
import type { DeckAiSession } from '#/main/ai/session/types.ts'
import { createAiSessionManager, type AiSessionManager } from '#/main/app-window/ai-session-manager.ts'
import { DeckSession } from '#/main/app-window/deck-session.ts'
import { appChrome, supportsOverlayThemeUpdates, overlayForTheme } from '#/main/chrome-strategy.ts'
import { type DeckContext } from '#/main/deck-types.ts'
import { t } from '#/main/i18n/index.ts'
import { buildMenu } from '#/main/menu/index.ts'
import { TOPBAR_PX } from '#/main/window-layout.ts'
import { allAppWindows, registerAppWindow, unregisterAppWindow } from '#/main/window-registry.ts'
import {
  APP_ICON,
  appCanvasBg,
  CHROME_HTML,
  CHROME_PRELOAD,
  initialThemeQuery,
  type Rect,
  sharedWebPreferences,
} from '#/main/window-shell.ts'
import {
  flushWindowState,
  getCachedWindowState,
  resolveInitialBounds,
  saveWindowState,
} from '#/main/window-state.ts'
import { DeckViewController } from '#/main/app-window/deck-view-controller.ts'
import type { AppMode, AppState, DeckSubView } from '#/main/app-window/types.ts'

export type { AppMode, AppState, DeckSubView } from '#/main/app-window/types.ts'

/**
 * Single-window application shell.
 *
 * Each `AppWindow` is a `BaseWindow` hosting two `WebContentsView`s:
 *   - `chromeView`  — our UI (launcher cards / editor chat / player exit
 *                     affordance), loaded from the renderer bundle.
 *                     Always present.
 *   - `deckView`    — the Deck preview. Created on demand when a deck is
 *                     loaded, destroyed when the deck is closed (managed
 *                     by `DeckViewController`).
 *
 * Mode transitions:
 *
 *   launcher --openDeck--> player --enterEditor--> editor
 *   editor   --enterPlayer--> player
 *   player/editor --closeDeck--> launcher
 *
 * AppWindow is a coordinator: it owns the window/chrome shell and the
 * preview view, and delegates deck-loading lifecycle to `DeckSession`
 * and AI session lifecycle to `AiSessionManager`. The two managers
 * communicate through callbacks AppWindow installs at construction
 * time — neither holds a back-reference to AppWindow.
 *
 * Mutual exclusion of the same deck across windows is enforced inside
 * `DeckSession.open()` via the window registry.
 */
export class AppWindow {
  private readonly win: BaseWindow
  private readonly chromeView: WebContentsView
  private readonly deckCtrl: DeckViewController
  private readonly deckSession: DeckSession
  private readonly aiManager: AiSessionManager
  private readonly winId: number
  private readonly chromeWcId: number
  private mode: AppMode = 'launcher'
  private subView: DeckSubView = 'edit'
  private loading = false
  private isFullScreen = false
  private disposed = false

  constructor() {
    // Restore previous bounds when they still land on a connected
    // display; otherwise size relative to the primary work area.
    // `getCachedWindowState` is populated by `loadWindowState()` during
    // boot (main.ts), so this read is sync and always up to date.
    // The cascade offset (30px × N) prevents a New Window from landing
    // exactly on top of the existing one. `allAppWindows()` here counts
    // already-registered windows; this AppWindow registers itself
    // *after* its BaseWindow is constructed (see `registerAppWindow`
    // below), so the count is the number of older siblings.
    const initial = resolveInitialBounds(getCachedWindowState(), allAppWindows().length)
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
      // Center macOS traffic lights vertically in our 32px topbar.
      // y = (TOPBAR_PX - lightDiameter) / 2 = (32 - 12) / 2.
      trafficLightPosition: { x: 16, y: (TOPBAR_PX - 12) / 2 },
      ...initial,
      minWidth: 960,
      minHeight: 600,
      title: 'Deck',
      icon: APP_ICON,
      backgroundColor: appCanvasBg(),
    })

    // Win/Linux: suppress the native menu bar entirely. The app menu is
    // rendered in-window by AppMenu.tsx; the native Menu is still
    // installed (see menu/index.ts::buildMenu) so accelerators bind globally.
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

    this.deckCtrl = new DeckViewController(this.win)

    this.aiManager = createAiSessionManager({
      chromeWebContents: this.chromeView.webContents,
      getDeck: () => this.deckSession.getDeck(),
      onMutation: () => this.deckSession.markDirty(),
      capturePreview: () => this.captureDeckView(),
    })

    this.deckSession = new DeckSession({
      win: this.win,
      ownerWindow: this,
      onStateChange: () => this.broadcastState(),
      onBeforeTeardown: async () => {
        // Tell the renderer to clear chat state BEFORE we dispose the AI
        // session — once `dispose` unsubscribes the listener, any
        // agent_end emitted by the abort path won't reach the renderer,
        // leaving its `streaming` flag stuck true and stale chat nodes
        // that the next `deck:history_replay` would concatenate with the
        // new deck's transcript.
        this.aiManager.emitSessionResetIfActive()
        try {
          await this.aiManager.teardown()
        } catch (err) {
          console.warn('[AppWindow] aiManager.teardown threw', err)
        }
        try {
          this.deckCtrl.teardown()
        } catch (err) {
          console.warn('[AppWindow] deckCtrl.teardown threw', err)
        }
        if (this.win.isDestroyed()) return
        // Reset window-level UI state. Title is restored by DeckSession
        // when not destroyed; mode/subView reset here.
        this.mode = 'launcher'
        this.subView = 'edit'
      },
      onWatcherChange: () => this.reloadDeck(false),
    })

    this.winId = this.win.id
    this.chromeWcId = this.chromeView.webContents.id
    registerAppWindow(this, { windowId: this.winId, chromeWcId: this.chromeWcId })

    this.wireWindowEvents()

    // Load the chrome UI. `loadFile` is async but we don't need to await
    // — renderer requests the current state via IPC on DOMContentLoaded.
    // The `theme` query is consumed by the inline boot script in
    // index.html to stamp `data-theme` before any CSS evaluates, avoiding
    // a white flash on dark-pref users.
    void this.chromeView.webContents.loadFile(CHROME_HTML, { query: initialThemeQuery() })

    this.applyChromeLayout()
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
    return this.deckSession.getDeck()
  }

  getAiSession(): DeckAiSession | null {
    return this.aiManager.get()
  }

  getState(): AppState {
    const deck = this.deckSession.getDeck()
    return {
      mode: this.mode,
      subView: this.subView,
      deck: deck
        ? {
            rootDir: deck.rootDir,
            manifest: deck.manifest,
            kind: deck.kind,
            sourcePath: deck.sourcePath,
          }
        : null,
      loading: this.loading,
      isFullScreen: this.isFullScreen,
      dirty: this.deckSession.isDirty(),
    }
  }

  /** Mark the deck as having unsaved changes. No-op for Source kind. */
  markDirty(): void {
    this.deckSession.markDirty()
  }

  /** Mark the deck as in sync with sourcePath. Called after Save succeeds. */
  markClean(): void {
    this.deckSession.markClean()
  }

  isDirty(): boolean {
    return this.deckSession.isDirty()
  }

  /**
   * Save the current deck. For a Pack: rezip rootDir → sourcePath.
   * For a Source: no-op. Returns true on success.
   *
   * Pass `silent: true` from the close path so save errors don't pop a
   * dialog the user can't act on (window is already going away).
   * `saveDeckInWindow` still writes a recovery copy when the original
   * `.deck` was deleted mid-edit — silent doesn't mean "lose data".
   */
  saveDeck(opts?: { silent?: boolean }): Promise<boolean> {
    return this.deckSession.save(opts)
  }

  focus(): void {
    if (this.win.isDestroyed()) return
    if (this.win.isMinimized()) this.win.restore()
    this.win.focus()
  }

  // ---- Mode transitions ---------------------------------------------------

  /**
   * Load `deckPath` (a `.deck` file or a directory with `deck.json`) and
   * switch the window into deck mode.
   *
   * `preferredSubView` picks the default sub-view: 'auto' (default),
   * 'play', or 'edit'. With 'auto' a Pack opened from the Launcher
   * lands in Play (it's a finished artifact); the menu's "Edit Deck"
   * action overrides to 'edit'.
   *
   * Broadcasts a `loading: true` state while extracting / starting the
   * server so the launcher renderer can show a spinner.
   */
  async openDeck(deckPath: string, preferredSubView: DeckSubView | 'auto' = 'auto'): Promise<boolean> {
    this.loading = true
    this.broadcastState()

    const deck = await this.deckSession.open(deckPath)
    if (!deck) {
      this.loading = false
      this.broadcastState()
      return false
    }

    // Sub-view default: Pack/Preview → play (distribution form / quick
    // preview, the user expects to view it), Source → edit (authoring
    // artifact). Menu overrides via explicit preferredSubView. (Preview
    // hides the toggle entirely, so the default sticks.)
    const sub: DeckSubView = preferredSubView === 'auto' ? (deck.kind === 'source' ? 'edit' : 'play') : preferredSubView

    try {
      await this.enterDeckMode(deck, sub)
    } catch (err) {
      // `DeckSession.open()` already succeeded, so the deck (server +
      // tmpdir + watcher) is registered and live. Anything thrown by
      // `enterDeckMode` (e.g. `aiManager.ensure()` failing because the
      // settings module rejects the loaded provider config) leaves us
      // mid-transition: server up, deck registered, but no AI session
      // and `mode` still 'launcher'. Run a full close so resources don't
      // leak, surface the failure, and return false. closeDeck is
      // idempotent and never throws.
      await this.closeDeck()
      this.loading = false
      this.broadcastState()
      const message = err instanceof Error ? err.message : String(err)
      void dialog.showMessageBox({
        type: 'error',
        title: t('dialog.failedToOpen.title'),
        message: t('dialog.failedToOpen.message'),
        detail: `${message}\n\nPath: ${deckPath}`,
      })
      return false
    }
    this.loading = false
    this.broadcastState()
    return true
  }

  /**
   * Tear down the current deck — flush pending edits to disk for Packs,
   * stop its server, delete the temp extraction (Pack only), drop the
   * deckView, and return to launcher mode. Idempotent.
   */
  async closeDeck(): Promise<void> {
    return this.deckSession.close()
  }

  /** Switch sub-view. The AI session is tied to the deck's lifetime,
   *  not the sub-view — flipping to Play and back must NOT lose the
   *  chat transcript or abort a streaming turn. Session
   *  creation/teardown happens in `enterDeckMode` / `closeDeck` /
   *  `handleClosed` only.
   *
   *  Renderer-driven layout: broadcast the new sub-view, the renderer
   *  collapses (or expands) the chat pane via a CSS width transition,
   *  and a ResizeObserver pushes preview bounds every frame so the
   *  deckView grows continuously into the freed space. We do NOT hide
   *  the view here — that would cause the deckView to disappear for the
   *  whole transition. */
  setSubView(next: DeckSubView): void {
    if (this.mode !== 'deck' || !this.deckSession.getDeck()) return
    if (this.subView === next) return
    this.subView = next
    // Move focus to the layer the user is about to interact with:
    // play hands focus to the deck's webContents (so arrow keys /
    // space drive the slides), edit hands focus back to the chrome
    // (so typing in the chat input works without a manual click —
    // Composer's effect then puts the caret in the textarea).
    if (next === 'play') {
      this.deckCtrl.focusContent()
    } else if (!this.chromeView.webContents.isDestroyed()) {
      this.chromeView.webContents.focus()
    }
    this.broadcastState()
  }

  /** Convenience — equivalent to `setSubView('edit')`. No-op for preview
   *  kind: there's no AI session / chat pane to enter, and the menu
   *  item that drives this is gated, but a stale IPC or future caller
   *  shouldn't be able to land a preview deck in an unusable edit view. */
  enterEditor(): void {
    if (this.deckSession.getDeck()?.kind === 'preview') return
    this.setSubView('edit')
  }

  /** Convenience — equivalent to `setSubView('play')`. */
  enterPlayer(): void {
    this.setSubView('play')
  }

  toggleFullScreen(): void {
    if (this.win.isDestroyed()) return
    this.win.setFullScreen(!this.win.isFullScreen())
  }

  /**
   * Toggle "presentation" — OS fullscreen with the deckView pinned to
   * the entire content area (no topbar, no chrome). Symmetric: a second
   * call exits.
   *
   * Main owns the deckView bounds for the duration via
   * `DeckViewController.lockToFullScreen` — renderer-pushed bounds are
   * ignored, the rect is recomputed from `getContentSize()` whenever the
   * window resizes (i.e. when the OS fullscreen animation lands). On
   * exit, we unlock and the renderer's measure path takes over.
   */
  togglePresentation(): void {
    if (this.win.isDestroyed()) return
    // Unlock is paired with leave-full-screen, not done here — see
    // `onFullScreenChange`. That way Esc / red-green-button / menu
    // exits go through the same path as the topbar button.
    if (this.win.isFullScreen()) {
      this.win.setFullScreen(false)
    } else {
      this.deckCtrl.lockToFullScreen()
      this.win.setFullScreen(true)
    }
  }

  /** Reload the current deck preview. */
  reloadDeck(ignoreCache = false): void {
    const deck = this.deckSession.getDeck()
    if (!deck) return
    // For a quick-preview .html: re-copy the user's source file into the
    // staged tmpdir so refresh picks up edits made to the original.
    // Best-effort — if the source has been moved/deleted, fall through
    // to reloading whatever's already staged.
    if (deck.kind === 'preview') {
      copyFile(deck.sourcePath, path.join(deck.rootDir, 'index.html'))
        .catch(() => {})
        .finally(() => this.deckCtrl.reload(deck.server.url, ignoreCache))
      return
    }
    this.deckCtrl.reload(deck.server.url, ignoreCache)
  }

  setPreviewBounds(rect: Rect): void {
    this.deckCtrl.setBounds(rect)
  }

  captureDeckView(): Promise<{ dataUrl: string; rect: Rect } | null> {
    if (this.mode !== 'deck') return Promise.resolve(null)
    return this.deckCtrl.capture()
  }

  applyChromeTheme(theme: 'dark' | 'light'): void {
    if (!supportsOverlayThemeUpdates || this.win.isDestroyed()) return
    // The persistent chrome topbar always covers the OS caption region,
    // so the deck preview never sits behind the titleBarOverlay. One
    // overlay per theme is enough — no per-mode tint.
    try {
      this.win.setTitleBarOverlay(overlayForTheme(theme === 'dark'))
    } catch {
      // Not created with titleBarStyle: 'hidden' — safe to ignore.
    }
  }

  /**
   * Replace the current AI session with one pointing at `sessionPath`.
   * Used by the History popover. Aborts any in-flight turn first, tears
   * down the existing session (the JSONL file stays — we only own the
   * runtime), and creates a fresh `DeckAiSession` seeded from the
   * picked file. The new session emits `deck:history_replay` which the
   * renderer uses to repaint the chat list.
   */
  async switchAiSession(sessionPath: string): Promise<void> {
    return this.aiManager.switch(sessionPath)
  }

  // ---- Internals ----------------------------------------------------------

  private wireWindowEvents(): void {
    // Resize the chromeView with the window. The deckView tracks via
    // the renderer's ResizeObserver → setPreviewBounds path — we don't
    // size it here, so there's only one place layout decisions are made.
    this.win.on('resize', () => {
      this.applyChromeLayout()
      this.deckCtrl.refreshLockedBounds()
      this.persistBounds()
    })
    this.win.on('move', () => this.persistBounds())

    // Fullscreen state mirror + presentation lock pairing. Symmetric:
    // enter refreshes the locked rect with the post-animation content
    // size; leave drops the lock so renderer-pushed bounds take over.
    // Covers every exit path (topbar Maximize button, View menu,
    // shortcut, red-green-button) without needing `togglePresentation`
    // to handle them.
    const onFullScreenChange = (value: boolean) => {
      this.isFullScreen = value
      if (value) {
        this.deckCtrl.refreshLockedBounds()
        // Hand keyboard focus to the deck's webContents so the user's
        // first keystroke (typically Space for "next slide") lands in
        // the deck instead of re-firing the topbar Maximize button
        // that triggered the full-screen. No-op when not in
        // presentation mode (Edit / Source full-screen keeps chat focus).
        this.deckCtrl.focusContentIfLocked()
      } else {
        this.deckCtrl.unlockBounds()
      }
      this.broadcastState()
    }
    this.win.on('enter-full-screen', () => onFullScreenChange(true))
    this.win.on('leave-full-screen', () => onFullScreenChange(false))

    // Menu items gate on the focused window's deck state, so rebuild
    // when focus shifts between our windows.
    this.win.on('focus', () => buildMenu())

    // `close` fires before the native window is destroyed so we can
    // still read bounds; `closed` happens after destruction. Capture
    // here, flush there.
    this.win.on('close', () => {
      this.persistBounds()
      void flushWindowState(this.winId)
    })

    // `handleClosed` is async; swallow any rejection so an unexpected
    // throw can't surface as Electron's "uncaught exception" dialog.
    this.win.once('closed', () => {
      this.handleClosed().catch((err) => {
        console.error('[AppWindow] handleClosed failed', err)
      })
    })
  }

  /** Snapshot the current "normal" window bounds to disk. Skipped while
   *  fullscreen — `getNormalBounds()` is unreliable mid-fullscreen, and
   *  resize events fire during the OS animation before the
   *  `enter-full-screen` / `leave-full-screen` listener runs, so we
   *  can't rely on `this.isFullScreen` to gate them. Querying the
   *  BaseWindow directly avoids the event-ordering question. */
  private persistBounds(): void {
    if (this.win.isDestroyed()) return
    if (this.win.isFullScreen()) return
    // `getNormalBounds()` returns the pre-maximize/zoom rect on every
    // platform — exactly what we want to restore on the next launch.
    const b = this.win.getNormalBounds()
    saveWindowState(this.winId, { x: b.x, y: b.y, width: b.width, height: b.height })
  }

  private broadcastState(): void {
    if (this.chromeView.webContents.isDestroyed()) return
    try {
      this.chromeView.webContents.send('app:state', this.getState())
    } catch {
      // Destroyed between the check and the send — teardown race.
    }
    // Rebuild the application menu so items that gate on deck shape
    // (e.g. File → Save, which only enables for Pack-kind decks)
    // reflect the new state.
    buildMenu()
  }

  /** Enter deck mode at `subView`. Ensures server-backed deckView and
   *  the AI session (every deck is editable — Pack edits flush back on
   *  close). Session lifetime is tied to the deck, not the sub-view —
   *  Play ↔ Edit flips don't touch it. Teardown is symmetric on closeDeck.
   *
   *  Renderer-driven layout: the deckView is created here but its
   *  bounds are not set until the renderer's ResizeObserver fires and
   *  pushes us a rect via setPreviewBounds. */
  private async enterDeckMode(deck: DeckContext, subView: DeckSubView): Promise<void> {
    this.mode = 'deck'
    this.subView = subView
    this.deckCtrl.ensure(deck.server.url)
    // Pack/Source decks are editable (Pack edits flush back to
    // sourcePath on close). Always start the AI session, even in Play
    // sub-view, so flipping into Edit is instant and carries the full
    // transcript. Preview is read-only quick view — no AI.
    if (deck.kind !== 'preview') {
      await this.aiManager.ensure()
    }
    // When entering Play mode directly (e.g., opening a Pack), move focus
    // to deck content so keyboard navigation works immediately.
    if (subView === 'play') {
      this.deckCtrl.focusContent()
    }
    this.broadcastState()
  }

  /**
   * Size the chromeView to fill the window content area. The deckView's
   * bounds come from the renderer (see `setPreviewBounds`), so they're
   * not touched here.
   */
  private applyChromeLayout(): void {
    if (this.win.isDestroyed()) return
    const [w, h] = this.win.getContentSize()
    this.chromeView.setBounds({ x: 0, y: 0, width: w, height: h })
  }

  private async handleClosed(): Promise<void> {
    if (this.disposed) return
    this.disposed = true

    // If `closeDeck` is in flight (the user closed the window during a
    // silent rezip, watcher.close, or aiSession.dispose await), let it
    // finish first. DeckSession owns nulling its own deck/watcher state;
    // once it's done `disposeOnWindowClosed` correctly no-ops instead of
    // running a parallel second teardown that would double-close the
    // http server, double-dispose the AI session, and double-close the
    // deck watcher.
    try {
      await this.deckSession.awaitClosing()
    } catch {
      // closeDeck swallows its own step errors; rethrow here would
      // surface as Electron's "uncaught exception" dialog.
    }

    // Drop registry entries first, before any resource cleanup that
    // could throw. Use cached ids — `this.win` /
    // `this.chromeView.webContents` are already destroyed by the time
    // `closed` fires, so their `.id` getters throw "Object has been
    // destroyed".
    unregisterAppWindow({ windowId: this.winId, chromeWcId: this.chromeWcId })

    // Tear down the deckView unconditionally — even on launcher-only
    // close. `disposeOnWindowClosed` short-circuits when no deck is
    // loaded, so it can't be the only path to deckCtrl.teardown. The
    // deckView may have been created without ever being attached
    // (closed mid-load) — in that case BaseWindow teardown won't reach
    // it, and we'd leak its renderer process. teardown() is idempotent,
    // so when a deck IS loaded the duplicate call inside
    // `onBeforeTeardown` no-ops.
    try {
      this.deckCtrl.teardown()
    } catch (err) {
      console.warn('[AppWindow] deckCtrl.teardown threw', err)
    }

    // Final pass through deck teardown for the case where the window
    // was closed without a prior closeDeck (the deck was still loaded).
    // disposeOnWindowClosed → onBeforeTeardown disposes AI + (redundantly)
    // deckCtrl; the redundant teardown is harmless (idempotent).
    try {
      await this.deckSession.disposeOnWindowClosed()
    } catch (err) {
      console.warn('[AppWindow] disposeOnWindowClosed threw', err)
    }
  }

  close(): void {
    if (!this.win.isDestroyed()) this.win.close()
  }

  isDestroyed(): boolean {
    return this.win.isDestroyed()
  }
}
