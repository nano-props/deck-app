export interface DeckManifest {
  name: string
  author?: string
  description?: string
  cover?: string
  version?: string
  [key: string]: unknown
}

export interface LoadedDeck {
  rootDir: string
  manifest: DeckManifest
  /** If true, the caller must delete `rootDir` on close (temp extraction). */
  ownsRootDir: boolean
}
