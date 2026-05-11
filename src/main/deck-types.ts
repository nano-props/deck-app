import type { DeckServer } from '#/main/server.ts'

export interface DeckManifest {
  name: string
  author?: string
  description?: string
  cover?: string
  version?: string
  [key: string]: unknown
}

/**
 * What `rootDir` is physically backed by.
 * - 'pack':    temp extraction of a `.deck` zip. Edits accumulate here and
 *              are zipped back to the original `.deck` on Save / close.
 *              Deleted on close after the rezip.
 * - 'source':  the user's own on-disk Deck Source directory. Edits land
 *              directly in the directory; nothing to zip.
 * - 'preview': a single `.html` file copied into a temp dir alongside a
 *              synthesized deck.json. Read-only quick preview — no save,
 *              no edit toggle, no AI session. Tmpdir is deleted on close.
 *
 * "Deck Source" is no longer surfaced in the UI; the user-facing model
 * is just "open a .deck". Source remains as an internal concept so
 * developers can `Open Folder…` against a working tree.
 */
export type DeckKind = 'pack' | 'source' | 'preview'

export interface LoadedDeck {
  rootDir: string
  manifest: DeckManifest
  kind: DeckKind
}

/**
 * Loaded deck + its running HTTP server, as tracked by an AppWindow.
 * Lives here (not in the AppWindow module) so the window registry and
 * IPC layer can reference the shape without importing the full class.
 */
export interface DeckContext {
  rootDir: string
  manifest: DeckManifest
  kind: DeckKind
  /**
   * The original path the user opened: a `.deck` file (kind 'pack') or
   * a directory (kind 'source'). Doubles as the deck's stable identity:
   * window-mutex and chat-history are keyed off this, not `rootDir` —
   * `rootDir` for a Pack is a per-open tmpdir that changes every time.
   */
  sourcePath: string
  server: DeckServer
}

