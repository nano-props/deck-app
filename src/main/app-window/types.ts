import type { DeckContext } from '#/main/deck-types.ts'

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
  deck: Pick<DeckContext, 'rootDir' | 'manifest' | 'kind' | 'sourcePath'> | null
  /** True while an openDeck flow is in flight (launcher → deck). */
  loading: boolean
  /** OS-level fullscreen state. Mirrors `BaseWindow.isFullScreen()`. */
  isFullScreen: boolean
  /**
   * True when the live extraction has changes not yet flushed to
   * sourcePath. Always false for kind 'source' (writes land directly).
   * Used by the topbar to show an unsaved indicator and enable Save.
   */
  dirty: boolean
}
