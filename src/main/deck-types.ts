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
 * - 'pack':      throwaway temp extraction of a `.deck` zip opened in Play.
 *                Read-only to the user; deleted on close.
 * - 'source':    the user's own on-disk Deck Source directory.
 * - 'workspace': an app-managed unpack of a `.deck` for editing.
 *                Persists across sessions (see workspaces.ts).
 */
export type DeckKind = 'pack' | 'source' | 'workspace'

export interface LoadedDeck {
  rootDir: string
  manifest: DeckManifest
  kind: DeckKind
  /** If true, the caller must delete `rootDir` on close. */
  deleteOnClose: boolean
}

/**
 * Loaded deck + its running HTTP server, as tracked by an AppWindow.
 * Lives here (not app-window.ts) so the window registry and IPC layer
 * can reference the shape without importing the full class.
 */
export interface DeckContext {
  rootDir: string
  manifest: DeckManifest
  kind: DeckKind
  deleteOnClose: boolean
  /** The original path the user opened: `.deck` zip, or same as rootDir. */
  sourcePath: string
  server: DeckServer
}

/** A Deck is editable if its rootDir is a persistent, writable directory. */
export function isEditable(kind: DeckKind): boolean {
  return kind !== 'pack'
}
