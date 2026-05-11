import { BaseWindow, dialog } from 'electron'
import { rm } from 'node:fs/promises'
import { loadDeck } from '#/main/deck-loader.ts'
import { saveDeckInWindow, type SaveTarget } from '#/main/dialogs.ts'
import { type DeckContext, type DeckKind, type DeckManifest } from '#/main/deck-types.ts'
import { watchDeckSource, type DeckWatcher } from '#/main/deck-watcher.ts'
import { t } from '#/main/i18n/index.ts'
import { startDeckServer } from '#/main/server.ts'
import { claimOpening, findAppWindowBySourcePath, isOpeningSourcePath, releaseOpening } from '#/main/window-registry.ts'
import type { AppWindow } from '#/main/app-window/index.ts'

export interface DeckSessionDeps {
  /** Used by save dialogs as a parent window and for `isDestroyed` checks. */
  win: BaseWindow
  /** The AppWindow that hosts this session — used in `open()` so the
   *  cross-window mutual-exclusion check (`existing !== ownerWindow`)
   *  can recognize the current window and proceed instead of bailing
   *  back at it. Reference equality only; never invoked. */
  ownerWindow: AppWindow
  /** Notify the AppWindow whenever a deck/dirty state change should be
   *  rebroadcast to the renderer. */
  onStateChange: () => void
  /** Called during close, between watcher teardown and server close.
   *  AppWindow uses this to dispose the AI session and tear down the
   *  preview view — it owns those resources. Invoked at most once per
   *  deck lifetime: either from the normal `close()` path OR from
   *  `disposeOnWindowClosed()` when the window is closed without a
   *  prior close — never both, since each path nulls `this.deck`
   *  before invoking the callback and the other path short-circuits on
   *  `!this.deck`. */
  onBeforeTeardown: () => Promise<void>
  /** Called when the file watcher fires. AppWindow decides what to do
   *  (typically reload the preview). markDirty is handled internally. */
  onWatcherChange: () => void
}

/**
 * Owns the deck-loading lifecycle: opens a deck (mutex + extraction +
 * server), tracks dirty state, owns the file-system watcher, and tears
 * everything down on close.
 *
 * The class deliberately does NOT know about the AI session, the
 * preview view, or the chrome WebContentsView. AppWindow wires those
 * via the `onBeforeTeardown` callback so the dependency only flows in
 * one direction (AppWindow → DeckSession), keeping this module
 * coordination-free.
 *
 * Save flow: `dialogs.saveDeckInWindow` operates on a `SaveTarget`
 * interface, which DeckSession satisfies by exposing `getDeck` /
 * `getBaseWindow` / `markClean`.
 */
export class DeckSession implements SaveTarget {
  private readonly deps: DeckSessionDeps
  private deck: DeckContext | null = null
  private deckWatcher: DeckWatcher | null = null
  /**
   * Resolves when an in-flight `close()` finishes. `disposeOnWindowClosed`
   * awaits this so the user closing the window mid-`close` (e.g. during
   * the silent rezip's hundreds-of-ms yield) can't run a second pass
   * through the same teardown.
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

  constructor(deps: DeckSessionDeps) {
    this.deps = deps
  }

  // ---- Queries ------------------------------------------------------------

  getDeck(): DeckContext | null {
    return this.deck
  }

  getBaseWindow(): BaseWindow {
    return this.deps.win
  }

  isDirty(): boolean {
    return this.dirty
  }

  // ---- Mutations ----------------------------------------------------------

  /** Mark the deck as having unsaved changes. No-op for Source kind. */
  markDirty(): void {
    if (!this.deck || this.deck.kind !== 'pack') return
    if (this.dirty) return
    this.dirty = true
    this.deps.onStateChange()
  }

  /** Mark the deck as in sync with sourcePath. Called after Save succeeds. */
  markClean(): void {
    if (!this.dirty) return
    this.dirty = false
    this.deps.onStateChange()
  }

  /**
   * Save the current deck. For a Pack: rezip rootDir → sourcePath.
   * For a Source: no-op. Returns true on success.
   */
  save(opts?: { silent?: boolean }): Promise<boolean> {
    return saveDeckInWindow(this, opts)
  }

  /**
   * Load `deckPath` (a `.deck` file or a directory with `deck.json`).
   * Returns the loaded deck on success, `null` if the open was rejected
   * (mutual-exclusion bail) or failed (a dialog was shown for failures).
   *
   * Mutual exclusion is keyed on `sourcePath` (not `rootDir`, since Pack
   * rootDirs are per-open tmpdirs that never match across opens). We
   * check both the live registry AND the in-flight openings set:
   * without the latter, two concurrent opens of the same `.deck` would
   * both pass the registry check (neither window has set its `deck`
   * yet) and proceed to extract twice.
   *
   * Watcher creation is gated by `kind !== 'preview'` and lives entirely
   * inside this method — preview decks have no watcher, no chat, no
   * persistence, so AppWindow doesn't need to participate.
   */
  async open(deckPath: string): Promise<DeckContext | null> {
    let loaded: { rootDir: string; manifest: DeckManifest; kind: DeckKind } | null = null
    let claimed = false
    try {
      // Check registry / in-flight slot BEFORE closing the current deck —
      // if the user picked a deck already loading elsewhere, we'd
      // otherwise tear down their current deck for a flow that's about
      // to bail with no replacement.
      const existing = findAppWindowBySourcePath(deckPath)
      if (existing && existing !== this.deps.ownerWindow) {
        existing.focus()
        return null
      }
      if (isOpeningSourcePath(deckPath)) {
        // Another window is mid-extraction for the same path. Bail
        // without touching anything. The other window's flow will
        // produce the visible result; we don't have a window handle to
        // focus yet (it hasn't registered its deck), so just no-op.
        return null
      }
      // claimOpening is the atomic step — Set.add + presence check in
      // one. Releasing happens in the `finally` below.
      claimed = claimOpening(deckPath)
      if (!claimed) {
        // Another caller won the race in the gap between
        // `isOpeningSourcePath` and here. Same bail as above.
        return null
      }

      // Now safe to close the current deck — we've claimed the slot and
      // are committed to opening `deckPath`.
      if (this.deck) await this.close()

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
      this.deps.win.setTitle(loaded.manifest.name)

      // Watch the deck's rootDir for out-of-band edits (user's own
      // editor, file manager drops, git operations). Skip for preview
      // — there's nothing to track and no AI/save plumbing wired.
      if (this.deck.kind !== 'preview') {
        this.startWatcher()
      }

      return this.deck
    } catch (err) {
      // Two failure shapes:
      //   - threw before `this.deck` was set (loadDeck / startDeckServer):
      //     no server, no resources to tear down. Throw away the partial
      //     extraction (only Packs/Previews produce one; Source's
      //     rootDir is user-owned).
      //   - threw after `this.deck` was set (very rare with the watcher
      //     start being the only follow-up): run a full close so we don't
      //     leak the running server.
      if (this.deck) {
        await this.close()
      } else if (loaded && (loaded.kind === 'pack' || loaded.kind === 'preview')) {
        await rm(loaded.rootDir, { recursive: true, force: true }).catch(() => {})
      }
      const message = err instanceof Error ? err.message : String(err)
      void dialog.showMessageBox({
        type: 'error',
        title: t('dialog.failedToOpen.title'),
        message: t('dialog.failedToOpen.message'),
        detail: `${message}\n\nPath: ${deckPath}`,
      })
      return null
    } finally {
      // Release the in-flight slot regardless of outcome. If we never
      // claimed (early bail), this is a no-op.
      if (claimed) releaseOpening(deckPath)
    }
  }

  /**
   * Tear down the current deck — flush pending edits to disk for Packs,
   * stop its server, delete the temp extraction (Pack only), and reset
   * to no-deck state. Idempotent.
   *
   * Save-on-close is silent and best-effort: if rezipping fails we still
   * tear the deck down (the user can `Save As…` to recover the live
   * extraction's contents from logs / temp). Surfacing a blocking dialog
   * here would trap the user with no clear path forward.
   */
  async close(): Promise<void> {
    if (!this.deck) return
    // Reentrancy: a second caller while one is in flight should observe
    // the same outcome instead of starting a parallel teardown.
    if (this.closingPromise) return this.closingPromise
    const p = this.closeImpl()
    this.closingPromise = p.finally(() => {
      this.closingPromise = null
    })
    return this.closingPromise
  }

  /** Wait for any in-flight close. Used by the window-closed teardown
   *  before it runs its own cleanup pass. */
  awaitClosing(): Promise<void> {
    return this.closingPromise ?? Promise.resolve()
  }

  /**
   * Window-close path. Mirrors `closeImpl` but with the additional
   * concern that the BaseWindow is already destroyed (we cannot set its
   * title or broadcast state). Steps still run in the same order so
   * teardown stays uniform; the tmpdir rm at the bottom is the
   * load-bearing one and runs unconditionally.
   *
   * Safe to call after a normal `close()` has already nulled the deck —
   * short-circuits in that case.
   */
  async disposeOnWindowClosed(): Promise<void> {
    if (!this.deck) return
    const deck = this.deck

    if (deck.kind === 'pack' && this.dirty) {
      await this.save({ silent: true }).catch(() => {})
    }

    this.deck = null
    this.dirty = false

    // Independent try/await per step. The tmpdir rm at the bottom is
    // load-bearing (otherwise extractions leak forever); a throw in any
    // earlier step must not skip it.
    if (this.deckWatcher) {
      const w = this.deckWatcher
      this.deckWatcher = null
      try {
        await w.close()
      } catch (err) {
        console.warn('[DeckSession] watcher close threw', err)
      }
    }
    try {
      await this.deps.onBeforeTeardown()
    } catch (err) {
      console.warn('[DeckSession] onBeforeTeardown threw', err)
    }
    try {
      await deck.server.close()
    } catch (err) {
      console.warn('[DeckSession] server.close threw', err)
    }
    if (deck.kind === 'pack' || deck.kind === 'preview') {
      await rm(deck.rootDir, { recursive: true, force: true }).catch((err) => {
        console.warn('[DeckSession] tmpdir rm failed', err)
      })
    }
  }

  // ---- Internals ----------------------------------------------------------

  private async closeImpl(): Promise<void> {
    if (!this.deck) return
    const deck = this.deck

    // Rezip BEFORE clearing this.deck so saveDeckInWindow can still see
    // the context. Skip if not dirty — saves wear on the .deck file
    // (and on git status) when the user just opened to look.
    // `silent: true` so a transient save failure doesn't pop a dialog
    // mid-teardown; saveDeckInWindow still writes a `.recovered.deck`
    // sibling if the original file vanished, so this is not data-lossy.
    if (deck.kind === 'pack' && this.dirty) {
      await this.save({ silent: true }).catch(() => {})
    }

    this.deck = null
    this.dirty = false

    // Each cleanup step is independent — failure in one MUST NOT skip
    // the others, especially the `rm` on the Pack tmpdir at the end.
    try {
      await this.teardownWatcher()
    } catch (err) {
      console.warn('[DeckSession] teardownWatcher threw', err)
    }
    try {
      await this.deps.onBeforeTeardown()
    } catch (err) {
      console.warn('[DeckSession] onBeforeTeardown threw', err)
    }
    try {
      await deck.server.close()
    } catch (err) {
      console.warn('[DeckSession] server.close threw', err)
    }
    // tmpdir cleanup is the load-bearing one — must run for every Pack
    // and Preview close path, otherwise extractions accumulate forever.
    // Source's rootDir is the user's own directory; never delete that.
    if (deck.kind === 'pack' || deck.kind === 'preview') {
      await rm(deck.rootDir, { recursive: true, force: true }).catch((err) => {
        console.warn('[DeckSession] tmpdir rm failed', err)
      })
    }

    // The awaits above yield to the event loop — the window may have
    // been closed in the meantime. Further mutations would throw and
    // leave cleanup half-done.
    if (this.deps.win.isDestroyed()) return
    this.deps.win.setTitle('Deck')
    this.deps.onStateChange()
  }

  /**
   * Watch the deck's rootDir for out-of-band edits. A change marks the
   * deck dirty (so close-time save flushes back to the original `.deck`)
   * and triggers `onWatcherChange` so AppWindow can reload the preview.
   *
   * AI tool writes already reload the preview via the chat `agent_end`
   * → `reloadPreview` path; the watcher doubles up for those, but the
   * built-in debounce keeps it to one reload per burst.
   */
  private startWatcher(): void {
    if (this.deckWatcher || !this.deck) return
    this.deckWatcher = watchDeckSource(this.deck.rootDir, () => {
      if (this.deps.win.isDestroyed()) return
      if (!this.deck) return
      this.markDirty()
      this.deps.onWatcherChange()
    })
  }

  private async teardownWatcher(): Promise<void> {
    if (!this.deckWatcher) return
    const w = this.deckWatcher
    this.deckWatcher = null
    await w.close().catch(() => {})
  }
}
