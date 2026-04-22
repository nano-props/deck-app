export type DeckDragMode = 'auto' | 'off'

export interface DeckManifest {
  name: string
  author?: string
  description?: string
  cover?: string
  version?: string
  /** See deck-spec §6. */
  drag?: DeckDragMode
  [key: string]: unknown
}

export interface LoadedDeck {
  rootDir: string
  manifest: DeckManifest
  /** If true, the caller must delete `rootDir` on close (temp extraction). */
  ownsRootDir: boolean
}

/**
 * Input is typed `unknown` because manifests are parsed from JSON — the
 * type system can't prove the value conforms.
 */
export function resolveDragMode(drag: unknown): DeckDragMode {
  if (drag === undefined || drag === 'auto') return 'auto'
  if (drag === 'off') return 'off'
  console.warn(`[deck] invalid "drag" value in deck.json: ${JSON.stringify(drag)} — defaulting to "auto"`)
  return 'auto'
}
