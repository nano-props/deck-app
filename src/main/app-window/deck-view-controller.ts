import { BaseWindow, WebContentsView } from 'electron'
import { appChrome } from '#/main/chrome-strategy.ts'
import { createDeckView } from '#/main/deck-view.ts'
import { installDragStrip } from '#/main/player-titlebar.ts'
import { type Rect } from '#/main/window-shell.ts'

/**
 * Owns the lifecycle and visibility of the deck preview WebContentsView.
 *
 * Why this is its own object: deckView visibility is governed by three
 * pieces of state that all need to land before the view becomes visible
 * (and any of them can arrive in any order):
 *
 *   - `loaded`    — first paint completed (did-stop-loading)
 *   - `attached`  — addChildView called on the host BaseWindow
 *   - `bounds`    — renderer measured the preview pane and pushed a Rect
 *
 * Adding the view before first paint causes a one-frame black flash on
 * macOS (WebContentsView's backing CALayer initializes black). Setting
 * bounds before first paint is fine but pointless. Both states need to
 * be in hand before reveal — this class is the synchronization point.
 */
export class DeckViewController {
  private view: WebContentsView | null = null
  private loaded = false
  private attached = false
  private bounds: Rect | null = null
  /**
   * Presentation lock — see `lockToFullScreen` for the contract.
   *
   * `preLockBounds` is the rect we'll restore on unlock. It exists
   * because `useDeckPreviewBounds` in the renderer dedups pushes by last
   * sent rect: during lock we ignore renderer pushes, but the renderer
   * never knew, so on unlock its next measure matches what it last sent
   * and gets dedup'd. We restore the snapshot from main instead of
   * waiting for the renderer to push something it considers a no-op.
   */
  private locked = false
  private preLockBounds: Rect | null = null
  // Set by `setVisible(false)` while a chrome-side overlay (Settings
  // modal, etc.) covers the window. Without this, any subsequent
  // `setBounds` push from the renderer would call `tryReveal` and snap
  // the deckView back to visible — which manifests as "Settings modal
  // is invisible in Player mode" because the deckView fills the entire
  // content area there and re-shows on top of the modal.
  private hiddenForOverlay = false
  // Plain field + assignment in the constructor body. Avoid the
  // `constructor(private readonly host)` parameter-property shorthand —
  // Electron's bundled Node runs us under "strip-only" TS, which rejects
  // parameter properties as unsupported syntax (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX).
  private readonly host: BaseWindow

  constructor(host: BaseWindow) {
    this.host = host
  }

  /** Create the deckView pointing at `serverUrl`. No-op if one already exists. */
  ensure(serverUrl: string): void {
    if (this.view) return
    const view = createDeckView({
      serverUrl,
      onLoadSettled: () => {
        // Guard against teardown-then-recreate: a stray did-stop-loading
        // for a torn-down view must not poison the new view's flags.
        if (this.view !== view) return
        this.loaded = true
        this.tryReveal()
      },
    })
    // Set field BEFORE loadURL — `did-stop-loading` could fire before
    // the next microtask on a fast cache hit, and onLoadSettled checks
    // `this.view !== view`.
    this.view = view
    this.loaded = false
    this.attached = false
    // macOS only: inject a transparent drag strip so the topbar stays
    // draggable even if the deck's HTML has a `position:fixed; top:0`
    // header that would otherwise steal hit-testing. Win/Linux use the
    // native titleBarOverlay, which sits above web content already.
    if (appChrome.playerInjectDragStrip) installDragStrip(view)
    void view.webContents.loadURL(serverUrl)
  }

  /**
   * Detach and close the deckView, resetting all state so the next
   * `ensure()` starts clean. Idempotent.
   *
   * `bounds` is cleared so the next deck waits for the renderer's first
   * push before reveal — without it, a fast `did-stop-loading` could
   * reveal the new deckView at the previous deck's rect for a frame
   * before the renderer's measure corrects it (the launcher's hidden
   * preview-pane never fires ResizeObserver, so cached bounds can be
   * arbitrarily stale by the time the next deck opens).
   *
   * `locked` / `preLockBounds` get cleared too — closing a deck while
   * still in OS fullscreen would otherwise leak the lock state into
   * the next `ensure()`.
   */
  teardown(): void {
    if (!this.view) return
    const view = this.view
    this.view = null
    this.loaded = false
    this.attached = false
    this.bounds = null
    this.locked = false
    this.preLockBounds = null
    this.hiddenForOverlay = false
    try {
      this.host.contentView.removeChildView(view)
    } catch {
      // Already removed (never attached, or detached during disposal).
    }
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  /**
   * Renderer-pushed preview-pane bounds. The renderer measures the
   * relevant DOM element and pushes the rect here via IPC. We cache it
   * and apply it to the deckView. This is the ONLY path that mutates
   * deckView geometry — layout source of truth = CSS in the renderer.
   */
  setBounds(rect: Rect): void {
    // Locked mode (presentation): ignore renderer pushes, main owns the rect.
    if (this.locked) return
    if (
      !Number.isFinite(rect.x) ||
      !Number.isFinite(rect.y) ||
      !Number.isFinite(rect.width) ||
      !Number.isFinite(rect.height)
    ) {
      return
    }
    this.bounds = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.max(0, Math.round(rect.width)),
      height: Math.max(0, Math.round(rect.height)),
    }
    this.tryReveal()
  }

  /**
   * Pin the deckView to the host's content area until unlocked. While
   * locked, renderer-pushed bounds are ignored and the rect is
   * recomputed from the host's current content size. Call
   * `refreshLockedBounds` after the OS resizes the window (fullscreen
   * animation, manual resize) to land on the new size.
   *
   * No-op when no view exists — without one we'd just flip the flag
   * and starve the next `setBounds` call. Idempotent: a second call
   * keeps the existing `preLockBounds` snapshot and just refreshes the
   * locked rect.
   */
  lockToFullScreen(): void {
    if (!this.view) return
    if (!this.locked) this.preLockBounds = this.bounds
    this.locked = true
    this.applyLockedBounds()
  }

  /**
   * Restore the pre-lock rect immediately. See `preLockBounds` for why
   * we don't wait for the renderer to push. If no snapshot exists
   * (`preLockBounds` null — only possible if lock fired before the
   * first renderer push, which can't happen via the topbar Maximize
   * button), we leave `bounds` at the fullscreen rect and rely on the
   * renderer's next push to correct it.
   */
  unlockBounds(): void {
    if (!this.locked) return
    this.locked = false
    if (this.preLockBounds) this.bounds = this.preLockBounds
    this.preLockBounds = null
    this.tryReveal()
  }

  /** Refresh the locked rect from the host's current content size.
   *  No-op when not locked. */
  refreshLockedBounds(): void {
    if (!this.locked) return
    this.applyLockedBounds()
  }

  private applyLockedBounds(): void {
    if (!this.view || this.view.webContents.isDestroyed()) return
    const [w, h] = this.host.getContentSize()
    // Dedup: window `resize` fires several times during a fullscreen
    // animation (intermediate frame sizes), but the rect we care about
    // is just (0, 0, contentW, contentH). Skip the redundant setBounds.
    if (
      this.bounds &&
      this.bounds.x === 0 &&
      this.bounds.y === 0 &&
      this.bounds.width === w &&
      this.bounds.height === h
    ) {
      return
    }
    this.bounds = { x: 0, y: 0, width: w, height: h }
    this.tryReveal()
  }

  /** Hide the deckView for the ~1-frame IPC gap during sub-view flips.
   *  setBounds re-shows it once the renderer pushes the new rect. */
  hideForLayoutFlip(): void {
    if (!this.view || this.view.webContents.isDestroyed()) return
    this.view.setVisible(false)
  }

  /**
   * Hide/show the deckView so DOM overlays in the chromeView (e.g. the
   * Settings modal) can cover the full window. Cross-view layering is
   * by child-view order, not z-index — toggling visibility is the cheap fix.
   *
   * Hiding sets `hiddenForOverlay` so subsequent `setBounds` /
   * `tryReveal` calls don't undo us; showing clears the flag and
   * routes through `tryReveal` so geometry / load state are honored.
   */
  setVisible(visible: boolean): void {
    if (!this.view || this.view.webContents.isDestroyed()) return
    if (visible) {
      this.hiddenForOverlay = false
      this.tryReveal()
    } else {
      this.hiddenForOverlay = true
      this.view.setVisible(false)
    }
  }

  /**
   * Snapshot the deck preview and return it with the bounds we last
   * pushed to the view. The renderer overlays a stand-in <img> at the
   * same rect so the Settings modal can draw a real semi-transparent
   * mask over the deck — without it, hiding the deckView leaves only
   * the chromeView's background showing through, which reads as a flat
   * gray panel.
   */
  async capture(): Promise<{ dataUrl: string; rect: Rect } | null> {
    if (!this.view || this.view.webContents.isDestroyed()) return null
    if (!this.bounds) return null
    const image = await this.view.webContents.capturePage()
    if (image.isEmpty()) return null
    return { dataUrl: image.toDataURL(), rect: this.bounds }
  }

  /** Reload the deck preview. */
  reload(serverUrl: string, ignoreCache: boolean): void {
    if (!this.view || this.view.webContents.isDestroyed()) return
    if (ignoreCache) {
      this.view.webContents.reloadIgnoringCache()
      return
    }
    // Re-loadURL with a cache-bust; reload() would hit Chromium's
    // in-memory cache and miss freshly-written AI edits.
    const bust = `_=${Date.now().toString(36)}`
    const url = serverUrl + (serverUrl.includes('?') ? '&' : '?') + bust
    void this.view.webContents.loadURL(url)
  }

  /** True if there's an underlying view (regardless of visibility). */
  exists(): boolean {
    return !!this.view && !this.view.webContents.isDestroyed()
  }

  /**
   * Move keyboard focus into the deck's webContents — but only while
   * the presentation lock is engaged. Without this, the topbar's
   * Maximize button keeps focus after entering full-screen, so the
   * user's first Space (intending "next slide") fires the button's
   * default action and exits full-screen instead.
   *
   * Restricted to `locked` so we don't steal focus during ordinary
   * Edit-mode full-screen toggles, where the chat-pane has every right
   * to keep typing focus.
   */
  focusContentIfLocked(): void {
    if (!this.locked) return
    if (!this.view || this.view.webContents.isDestroyed()) return
    this.view.webContents.focus()
  }

  /**
   * The deferred attach (addChildView on first call) is what eliminates
   * the cold-open black flash. Idempotent — every state change that
   * could affect deckView visibility (load completed, renderer-pushed
   * bounds, presentation lock entered/exited/refreshed) routes through
   * this.
   */
  private tryReveal(): void {
    if (!this.view || this.view.webContents.isDestroyed()) return
    if (!this.loaded || !this.bounds) return
    if (!this.attached) {
      this.host.contentView.addChildView(this.view)
      this.attached = true
    }
    this.view.setBounds(this.bounds)
    // Respect overlay-hide: setBounds is reached from renderer-pushed
    // resize events that fire even while Settings is up. Skipping the
    // setVisible(true) keeps the deck hidden under the modal.
    if (this.hiddenForOverlay) return
    this.view.setVisible(true)
  }
}
