import { BaseWindow, dialog, WebContentsView, type WebContents } from 'electron'
import { rm } from 'node:fs/promises'
import { createDeckAiSession } from '#/main/ai/session/index.ts'
import type { DeckAiSession } from '#/main/ai/session/types.ts'
import { appChrome, supportsOverlayThemeUpdates, overlayForTheme } from '#/main/chrome-strategy.ts'
import { loadDeck } from '#/main/deck-loader.ts'
import { saveDeckInWindow } from '#/main/dialogs.ts'
import { type DeckContext, type DeckKind, type DeckManifest } from '#/main/deck-types.ts'
import { watchDeckSource, type DeckWatcher } from '#/main/deck-watcher.ts'
import { t } from '#/main/i18n/index.ts'
import { buildMenu } from '#/main/menu/index.ts'
import { startDeckServer } from '#/main/server.ts'
import { TOPBAR_PX } from '#/main/window-layout.ts'
import {
  claimOpening,
  findAppWindowBySourcePath,
  isOpeningSourcePath,
  registerAppWindow,
  releaseOpening,
  unregisterAppWindow,
} from '#/main/window-registry.ts'
import {
  APP_ICON,
  appCanvasBg,
  CHROME_HTML,
  CHROME_PRELOAD,
  type Rect,
  sharedWebPreferences,
} from '#/main/window-shell.ts'
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
 * Mutual exclusion of the same deck across windows is enforced by
 * `findAppWindowBySourcePath` plus `claimOpening` (the latter covers
 * the in-flight gap between extract and registry-set).
 */
export class AppWindow {
  private readonly win: BaseWindow
  private readonly chromeView: WebContentsView
  private readonly deckCtrl: DeckViewController
  private readonly winId: number
  private readonly chromeWcId: number
  private deck: DeckContext | null = null
  private aiSession: DeckAiSession | null = null
  private deckWatcher: DeckWatcher | null = null
  private mode: AppMode = 'launcher'
  private subView: DeckSubView = 'edit'
  private loading = false
  private isFullScreen = false
  private disposed = false
  /**
   * Resolves when an in-flight `closeDeck()` finishes. `handleClosed`
   * awaits this so the user closing the window mid-`closeDeck` (e.g.
   * during the silent rezip's hundreds-of-ms yield) can't run a second
   * pass through the same teardown — `this.deck`, `this.aiSession`,
   * `this.deckWatcher` are all read-then-null patterns that would each
   * get hit twice and call `close()` / `dispose()` on the same object.
   */
  private closingPromise: Promise<void> | null = null
  /**
   * True when the live extraction (kind 'pack') has changes not yet
   * flushed back to the original `.deck` file. Set by AI tool runs and
   * the file watcher; cleared by Save / Save As (via markClean) and by
   * a successful close-time rezip. Always false for kind 'source' —
   * Source edits land directly on disk.
   */
  private dirty = false

  constructor() {
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
      width: 1280,
      height: 820,
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

    this.winId = this.win.id
    this.chromeWcId = this.chromeView.webContents.id
    registerAppWindow(this, { windowId: this.winId, chromeWcId: this.chromeWcId })

    this.wireWindowEvents()

    // Load the chrome UI. `loadFile` is async but we don't need to await
    // — renderer requests the current state via IPC on DOMContentLoaded.
    void this.chromeView.webContents.loadFile(CHROME_HTML)

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
            sourcePath: this.deck.sourcePath,
          }
        : null,
      loading: this.loading,
      isFullScreen: this.isFullScreen,
      dirty: this.dirty,
    }
  }

  /** Mark the deck as having unsaved changes. No-op for Source kind. */
  markDirty(): void {
    if (!this.deck || this.deck.kind !== 'pack') return
    if (this.dirty) return
    this.dirty = true
    this.broadcastState()
  }

  /** Mark the deck as in sync with sourcePath. Called after Save succeeds. */
  markClean(): void {
    if (!this.dirty) return
    this.dirty = false
    this.broadcastState()
  }

  isDirty(): boolean {
    return this.dirty
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
    return saveDeckInWindow(this, opts)
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
    let loaded: {
      rootDir: string
      manifest: DeckManifest
      kind: DeckKind
    } | null = null

    this.loading = true
    this.broadcastState()

    // Mutual exclusion BEFORE extraction — keyed on sourcePath, not
    // rootDir, since Pack rootDirs are per-open tmpdirs and would never
    // match across opens. We check both the live registry AND the
    // in-flight openings set: without the latter, two concurrent opens
    // of the same `.deck` would both pass the registry check (neither
    // window has set its `deck` yet) and proceed to extract twice.
    let claimed = false
    try {
      // Check registry / in-flight slot BEFORE closing the current deck
      // — if the user picked a deck already loading elsewhere, we'd
      // otherwise tear down their current deck for a flow that's about
      // to bail with no replacement.
      const existing = findAppWindowBySourcePath(deckPath)
      if (existing && existing !== this) {
        existing.focus()
        this.loading = false
        this.broadcastState()
        return false
      }
      if (isOpeningSourcePath(deckPath)) {
        // Another window is mid-extraction for the same path. Bail
        // without touching anything. The other window's flow will
        // produce the visible result; we don't have a window handle to
        // focus yet (it hasn't registered its deck), so just no-op.
        this.loading = false
        this.broadcastState()
        return false
      }
      // claimOpening is the atomic step — Set.add + presence check in
      // one. Releasing happens in the `finally` below.
      claimed = claimOpening(deckPath)
      if (!claimed) {
        // Another caller won the race in the gap between
        // `isOpeningSourcePath` and here. Same bail as above.
        this.loading = false
        this.broadcastState()
        return false
      }

      // Now safe to close the current deck — we've claimed the slot and
      // are committed to opening `deckPath`.
      if (this.deck) await this.closeDeck()

      loaded = await loadDeck(deckPath)

      const server = await startDeckServer(loaded.rootDir)

      this.deck = {
        rootDir: loaded.rootDir,
        manifest: loaded.manifest,
        kind: loaded.kind,
        sourcePath: deckPath,
        server,
      }
      this.dirty = false
      this.win.setTitle(loaded.manifest.name)

      // Sub-view default: Pack/Preview → play (distribution form / quick
      // preview, the user expects to view it), Source → edit (authoring
      // artifact). Menu overrides via explicit preferredSubView. (Preview
      // hides the toggle entirely, so the default sticks.)
      const sub: DeckSubView =
        preferredSubView === 'auto'
          ? loaded.kind === 'source'
            ? 'edit'
            : 'play'
          : preferredSubView

      await this.enterDeckMode(sub)
      this.loading = false
      this.broadcastState()
      return true
    } catch (err) {
      // Two failure shapes:
      //   - threw before `this.deck` was set (loadDeck / startDeckServer):
      //     no server, no deckView. Throw away the partial extraction
      //     (only Packs produce one; Source's rootDir is user-owned).
      //   - threw after `this.deck` was set (enterDeckMode → ensureAiSession
      //     → getSettings, etc.): server is up, deckView is loading. Run a
      //     full closeDeck so we don't leak resources. closeDeck is
      //     idempotent and never throws.
      if (this.deck) {
        await this.closeDeck()
      } else if (loaded && (loaded.kind === 'pack' || loaded.kind === 'preview')) {
        await rm(loaded.rootDir, { recursive: true, force: true }).catch(() => {})
      }
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
    } finally {
      // Release the in-flight slot regardless of outcome. If we never
      // claimed (early bail), this is a no-op.
      if (claimed) releaseOpening(deckPath)
    }
  }

  /**
   * Tear down the current deck — flush pending edits to disk for Packs,
   * stop its server, delete the temp extraction (Pack only), drop the
   * deckView, and return to launcher mode. Idempotent.
   *
   * Save-on-close is silent and best-effort: if rezipping fails we still
   * tear the deck down (the user can `Save As…` to recover the live
   * extraction's contents from logs / temp). Surfacing a blocking dialog
   * here would trap the user with no clear path forward.
   */
  async closeDeck(): Promise<void> {
    if (!this.deck) return
    // Reentrancy: a second caller while one is in flight should observe
    // the same outcome instead of starting a parallel teardown.
    if (this.closingPromise) return this.closingPromise
    const p = this.closeDeckImpl()
    this.closingPromise = p.finally(() => {
      this.closingPromise = null
    })
    return this.closingPromise
  }

  private async closeDeckImpl(): Promise<void> {
    if (!this.deck) return
    const deck = this.deck

    // Rezip BEFORE clearing this.deck so saveDeckInWindow can still see
    // the context. Skip if not dirty — saves wear on the .deck file
    // (and on git status) when the user just opened to look.
    // `silent: true` so a transient save failure doesn't pop a dialog
    // mid-teardown; saveDeckInWindow still writes a `.recovered.deck`
    // sibling if the original file vanished, so this is not data-lossy.
    if (deck.kind === 'pack' && this.dirty) {
      await this.saveDeck({ silent: true }).catch(() => {})
    }

    this.deck = null
    this.dirty = false

    // Each cleanup step is independent — failure in one MUST NOT skip
    // the others, especially the `rm` on the Pack tmpdir at the end.
    // teardownDeckWatcher / teardownAiSession already swallow inside,
    // but wrap them anyway in case of synchronous throws (e.g. a future
    // refactor regresses the internal .catch).
    try {
      await this.teardownDeckWatcher()
    } catch (err) {
      console.warn('[AppWindow] teardownDeckWatcher threw', err)
    }
    // Tell the renderer to clear chat state BEFORE we dispose the AI
    // session — once `dispose` unsubscribes the listener, any agent_end
    // emitted by the abort path won't reach the renderer, leaving its
    // `streaming` flag stuck true and stale chat nodes that the next
    // `deck:history_replay` would concatenate with the new deck's
    // transcript. session_reset clears nodes + streaming + attachments.
    if (this.aiSession && !this.chromeView.webContents.isDestroyed()) {
      try {
        this.chromeView.webContents.send('ai:event', { type: 'deck:session_reset' })
      } catch {
        // teardown race
      }
    }
    try {
      await this.teardownAiSession()
    } catch (err) {
      console.warn('[AppWindow] teardownAiSession threw', err)
    }
    try {
      this.deckCtrl.teardown()
    } catch (err) {
      console.warn('[AppWindow] deckCtrl.teardown threw', err)
    }
    try {
      await deck.server.close()
    } catch (err) {
      console.warn('[AppWindow] server.close threw', err)
    }
    // tmpdir cleanup is the load-bearing one — must run for every Pack
    // and Preview close path, otherwise extractions accumulate forever.
    // Source's rootDir is the user's own directory; never delete that.
    if (deck.kind === 'pack' || deck.kind === 'preview') {
      await rm(deck.rootDir, { recursive: true, force: true }).catch((err) => {
        console.warn('[AppWindow] tmpdir rm failed', err)
      })
    }

    // The awaits above yield to the event loop — the window may have
    // been closed in the meantime. Further window mutations would throw
    // and leave cleanup half-done.
    if (this.win.isDestroyed()) return

    this.win.setTitle('Deck')
    this.mode = 'launcher'
    this.subView = 'edit' // reset so re-opening defaults cleanly
    // bounds reset is folded into deckCtrl.teardown() above.
    this.broadcastState()
  }

  /** Switch sub-view. The AI session is tied to the deck's lifetime,
   *  not the sub-view — flipping to Play and back must NOT lose the
   *  chat transcript or abort a streaming turn. Session
   *  creation/teardown happens in `enterDeckMode` / `closeDeck` /
   *  `handleClosed` only.
   *
   *  Renderer-driven layout: broadcast the new sub-view, the renderer
   *  flips `data-subview`, CSS reflows chat-pane / preview-pane, a
   *  ResizeObserver pushes the new preview bounds via
   *  `setPreviewBounds`, and main re-shows the view at the new rect.
   *  To cover the ~1 frame IPC+reflow gap during which deckView still
   *  has its OLD bounds, we hide it here and let setPreviewBounds
   *  re-show it. The chromeView beneath uses `var(--bg)` (matching the
   *  deckView's own backing color), so the gap reads as a clean layout
   *  shift, not a flash. */
  setSubView(next: DeckSubView): void {
    if (this.mode !== 'deck' || !this.deck) return
    if (this.subView === next) return
    this.deckCtrl.hideForLayoutFlip()
    this.subView = next
    // When entering Play mode, move focus to the deck content so arrow
    // keys / space work immediately without requiring a manual click.
    // Edit mode keeps focus in the chrome (chat pane) for typing.
    if (next === 'play') {
      this.deckCtrl.focusContent()
    }
    this.broadcastState()
  }

  /** Convenience — equivalent to `setSubView('edit')`. No-op for preview
   *  kind: there's no AI session / chat pane to enter, and the menu
   *  item that drives this is gated, but a stale IPC or future caller
   *  shouldn't be able to land a preview deck in an unusable edit view. */
  enterEditor(): void {
    if (this.deck?.kind === 'preview') return
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
    if (!this.deck) return
    this.deckCtrl.reload(this.deck.server.url, ignoreCache)
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

  // ---- Internals ----------------------------------------------------------

  private wireWindowEvents(): void {
    // Resize the chromeView with the window. The deckView tracks via
    // the renderer's ResizeObserver → setPreviewBounds path — we don't
    // size it here, so there's only one place layout decisions are made.
    this.win.on('resize', () => {
      this.applyChromeLayout()
      this.deckCtrl.refreshLockedBounds()
    })

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

    // `handleClosed` is async; swallow any rejection so an unexpected
    // throw can't surface as Electron's "uncaught exception" dialog.
    this.win.once('closed', () => {
      this.handleClosed().catch((err) => {
        console.error('[AppWindow] handleClosed failed', err)
      })
    })
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
  private async enterDeckMode(subView: DeckSubView): Promise<void> {
    if (!this.deck) return
    this.mode = 'deck'
    this.subView = subView
    this.deckCtrl.ensure(this.deck.server.url)
    // Pack/Source decks are editable (Pack edits flush back to
    // sourcePath on close). Always start the AI session, even in Play
    // sub-view, so flipping into Edit is instant and carries the full
    // transcript. Preview is read-only quick view — no AI, no watcher.
    if (this.deck.kind !== 'preview') {
      await this.ensureAiSession()
      this.ensureDeckWatcher()
    }
    // When entering Play mode directly (e.g., opening a Pack), move focus
    // to deck content so keyboard navigation works immediately.
    if (subView === 'play') {
      this.deckCtrl.focusContent()
    }
    this.broadcastState()
  }

  private async ensureAiSession(): Promise<void> {
    if (this.aiSession || !this.deck) return
    // Wait for the chrome renderer to finish loading before we construct
    // the session. Session construction can emit `deck:history_replay`
    // synchronously (when there's a prior transcript on disk), and if
    // the renderer hasn't registered its `ai:event` listener yet that
    // message is lost. On cold start, chromeView.loadFile races deck
    // extraction — a warm filesystem cache can win the race.
    await this.whenChromeReady()
    if (!this.deck || this.chromeView.webContents.isDestroyed()) return
    const session = await createDeckAiSession({
      sender: this.chromeView.webContents,
      rootDir: this.deck.rootDir,
      chatKey: this.deck.sourcePath,
      deckName: this.deck.manifest.name,
      onMutation: () => this.markDirty(),
      capturePreview: () => this.captureDeckView(),
    })
    // handleClosed may have already run during the second await,
    // nulling this.aiSession. Dispose immediately and bail.
    if (!this.deck || this.chromeView.webContents.isDestroyed()) {
      await session.dispose().catch(() => {})
      return
    }
    this.aiSession = session
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
    if (!this.deck) return
    if (this.aiSession) {
      try {
        await this.aiSession.abort()
      } catch {
        // session already disposed mid-await — fine
      }
      await this.teardownAiSession()
    }
    await this.whenChromeReady()
    if (!this.deck || this.chromeView.webContents.isDestroyed()) return
    // Tell the renderer to drop the prior chat DOM before we replay the
    // new transcript — otherwise the two would concatenate visually.
    try {
      this.chromeView.webContents.send('ai:event', { type: 'deck:session_reset' })
    } catch {
      // Destroyed between the check and the send — teardown race.
    }
    // If sessionPath has been removed/corrupted out from under us
    // (external delete, partial transfer), don't leave the window
    // session-less — fall back to the default session so the user can
    // keep chatting. Caller's `chats:switch` IPC swallows the throw,
    // but a session-less window forces the renderer into a no-session
    // dead-end until the user reopens the deck.
    let session: DeckAiSession
    try {
      session = await createDeckAiSession({
        sender: this.chromeView.webContents,
        rootDir: this.deck.rootDir,
        chatKey: this.deck.sourcePath,
        deckName: this.deck.manifest.name,
        sessionPath,
        onMutation: () => this.markDirty(),
        capturePreview: () => this.captureDeckView(),
      })
    } catch (err) {
      console.warn('[AppWindow] switchAiSession: failed to open requested session, falling back to default', err)
      session = await createDeckAiSession({
        sender: this.chromeView.webContents,
        rootDir: this.deck.rootDir,
        chatKey: this.deck.sourcePath,
        deckName: this.deck.manifest.name,
        onMutation: () => this.markDirty(),
        capturePreview: () => this.captureDeckView(),
      })
    }
    if (!this.deck || this.chromeView.webContents.isDestroyed()) {
      await session.dispose().catch(() => {})
      return
    }
    this.aiSession = session
  }

  /**
   * Resolve when chromeView has finished its initial load. Uses
   * `webContents.isLoading()` as the fast path, `did-finish-load` /
   * `did-fail-load` as the slow path. Safe after disposal.
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
   * Watch the deck's rootDir for out-of-band edits (user's own editor,
   * file manager drops, git operations). A change triggers a preview
   * reload AND marks the deck dirty so close-time save flushes back to
   * the original `.deck`.
   *
   * AI tool writes already reload the preview via the chat `agent_end`
   * → `reloadPreview` path; the watcher doubles up for those, but the
   * built-in debounce keeps it to one reload per burst.
   */
  private ensureDeckWatcher(): void {
    if (this.deckWatcher || !this.deck) return
    this.deckWatcher = watchDeckSource(this.deck.rootDir, () => {
      if (this.win.isDestroyed()) return
      if (!this.deck) return
      this.markDirty()
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
    // finish first. It owns nulling `this.deck` / `this.aiSession` /
    // `this.deckWatcher`; once it's done the `if (this.deck)` block
    // below correctly no-ops instead of running a parallel second
    // teardown that would double-close the http server, double-dispose
    // the AI session, and double-close the deck watcher.
    if (this.closingPromise) {
      try {
        await this.closingPromise
      } catch {
        // closeDeck swallows its own step errors; rethrow here would
        // surface as Electron's "uncaught exception" dialog.
      }
    }

    // Drop registry entries first, before any resource cleanup that
    // could throw. Use cached ids — `this.win` /
    // `this.chromeView.webContents` are already destroyed by the time
    // `closed` fires, so their `.id` getters throw "Object has been
    // destroyed".
    unregisterAppWindow({ windowId: this.winId, chromeWcId: this.chromeWcId })

    // Clean up the deckView. The chromeView's WebContents is already
    // destroyed with the BaseWindow, but the deckView may have been
    // created without being attached (closed mid-load) — in that case
    // it isn't a child of this.win.contentView and the BaseWindow
    // teardown won't reach it. Explicitly close its webContents to
    // avoid leaking the renderer process.
    try {
      this.deckCtrl.teardown()
    } catch (err) {
      console.warn('[AppWindow] deckCtrl.teardown threw', err)
    }
    if (this.deck) {
      const deck = this.deck

      // Window-close path: same save-then-cleanup contract as closeDeck.
      // Save first so any AI edits make it back to the .deck file before
      // we tear the runtime down. Silent — the window is already gone,
      // there's no UI surface for a dialog. saveDeckInWindow still
      // writes a `.recovered.deck` sibling if the original was deleted,
      // so this remains data-safe.
      if (deck.kind === 'pack' && this.dirty) {
        await this.saveDeck({ silent: true }).catch(() => {})
      }

      this.deck = null
      this.dirty = false
      // Independent try/await per step. The tmpdir rm at the bottom is
      // load-bearing (otherwise extractions leak forever); a throw in
      // any earlier step must not skip it.
      if (this.deckWatcher) {
        const w = this.deckWatcher
        this.deckWatcher = null
        try {
          await w.close()
        } catch (err) {
          console.warn('[AppWindow] watcher close threw', err)
        }
      }
      if (this.aiSession) {
        const s = this.aiSession
        this.aiSession = null
        try {
          await s.dispose()
        } catch (err) {
          console.warn('[AppWindow] aiSession dispose threw', err)
        }
      }
      try {
        await deck.server.close()
      } catch (err) {
        console.warn('[AppWindow] server.close threw', err)
      }
      if (deck.kind === 'pack' || deck.kind === 'preview') {
        await rm(deck.rootDir, { recursive: true, force: true }).catch((err) => {
          console.warn('[AppWindow] tmpdir rm failed', err)
        })
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
