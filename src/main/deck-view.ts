/**
 * Deck preview WebContentsView creation.
 *
 * The deckView hosts untrusted deck HTML loaded from the per-deck local
 * server. This module wires up the boring-but-essential security
 * scaffolding: sandbox on, navigation locked to the server origin,
 * external links go to the OS browser, default-deny permissions.
 *
 * Lifecycle (state flags + visibility) is owned by AppWindow; this file
 * is pure construction.
 */

import { session, shell, WebContentsView } from 'electron'
import { appCanvasBg, sharedWebPreferences } from '#/main/window-shell.ts'

/**
 * Dedicated session partition for deck content. Isolates permission /
 * cookie / storage state from the chrome's default session — without it,
 * `setPermissionRequestHandler` below would run process-wide and silently
 * deny clipboard / notifications / pointerLock for the chromeView too.
 *
 * No `persist:` prefix — decks are local files served from a per-open
 * server, with no cross-deck identity that would benefit from persisted
 * cookies or storage.
 */
const DECK_PARTITION = 'deck'

export interface DeckViewParams {
  /** URL of the deck's local server (origin used to lock navigation). */
  serverUrl: string
  /** Called once the first deck navigation lands (success or failure). */
  onLoadSettled: () => void
}

/** Create a configured but unattached, unloaded deckView.
 *
 *  The caller must call `view.webContents.loadURL(serverUrl)` after it
 *  has wired up its own state (so the `did-stop-loading` callback can
 *  see consistent flags), and must add it to the contentView and show
 *  it (typically gated on first paint + bounds being known). */
export function createDeckView(params: DeckViewParams): WebContentsView {
  // Security defaults — preserved deliberately:
  //   - No `preload`. Deck HTML must NOT see a contextBridge surface; if
  //     a future feature wants to expose IPC into the deck, that's an
  //     audit-required change, not an oversight here.
  //   - Dedicated session partition (`deck`). Isolates the deck's
  //     permission / storage state from the chrome's default session,
  //     so our default-deny `setPermissionRequestHandler` below doesn't
  //     leak across the chromeView (or any future WebContents).
  //   - `sandbox: true`. The deck runs as untrusted HTML; sandboxing
  //     prevents Node access even if `nodeIntegration` ever flipped.
  // Combined with `contextIsolation: true` (from sharedWebPreferences),
  // an XSS in deck content cannot reach Node or our contextBridge API.
  const view = new WebContentsView({
    webPreferences: { ...sharedWebPreferences, sandbox: true, partition: DECK_PARTITION },
  })
  view.setBackgroundColor(appCanvasBg())
  view.setVisible(false)

  // Listen for the deck's first navigation outcome. We deliberately use
  // `did-finish-load` / `did-fail-load` (not `did-stop-loading`): the
  // latter fires for the implicit about:blank navigation a fresh
  // WebContents emits before the caller's loadURL kicks in, which would
  // make us mark the view as "loaded" and reveal at about:blank's white
  // backing for a frame before deck content paints.
  const onFirstLoadOutcome = () => {
    view.webContents.off('did-finish-load', onFirstLoadOutcome)
    view.webContents.off('did-fail-load', onFirstLoadOutcome)
    params.onLoadSettled()
  }
  view.webContents.on('did-finish-load', onFirstLoadOutcome)
  view.webContents.on('did-fail-load', onFirstLoadOutcome)

  const serverOrigin = new URL(params.serverUrl).origin

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

  return view
}

/**
 * Configure the deck partition's session once per process. Idempotent —
 * `session.fromPartition` always returns the same Session instance for a
 * given name, and `setPermissionRequestHandler` overwrites the previous
 * handler. Called from `main.ts` at startup so the deck partition is
 * locked down before any deck loads.
 *
 * Default-deny everything but fullscreen. Decks benefit from F11
 * presentation; future clipboard / camera / mic surface widens here.
 */
export function configureDeckSession(): void {
  const deckSession = session.fromPartition(DECK_PARTITION)
  deckSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'fullscreen')
  })
}
