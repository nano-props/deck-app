// Service Worker registration, messaging, and the deck-zip → SW hand-off.
// JSZip is a real npm dep now (vite bundles it); no UMD global.

import JSZip from 'jszip'
import { getT } from '#/web/lib/i18n.ts'

// Literal — must NOT be hashed by rollup. See vite.web.config.ts where
// the SW entry is pinned to `sw.js`.
const SW_URL = './sw.js'

export interface DeckManifest {
  name: string
  /** Allow extra fields to flow through without losing typings. The
   *  player only reads `name`. */
  [extra: string]: unknown
}

let swReady: Promise<ServiceWorkerRegistration> | null = null

async function ensureServiceWorker(): Promise<ServiceWorkerRegistration> {
  if (!('serviceWorker' in navigator)) {
    throw new Error('Service Workers are not supported in this browser.')
  }
  if (!swReady) {
    swReady = navigator.serviceWorker
      .register(SW_URL, { scope: './' })
      .then(async (reg) => {
        // Wait until the SW actually controls this page; otherwise the
        // first deck's iframe requests would fall through to the network.
        if (!navigator.serviceWorker.controller) {
          await new Promise<void>((resolve) => {
            navigator.serviceWorker.addEventListener(
              'controllerchange',
              () => resolve(),
              { once: true },
            )
          })
        }
        return reg
      })
  }
  return swReady
}

interface SwReply {
  ok: boolean
  error?: string
}

function postToSW(message: unknown): Promise<SwReply> {
  return new Promise((resolve, reject) => {
    const ctrl = navigator.serviceWorker.controller
    if (!ctrl) return reject(new Error('No active Service Worker.'))
    const channel = new MessageChannel()
    channel.port1.onmessage = (e: MessageEvent<SwReply>) => {
      const data = e.data
      if (data && data.ok) resolve(data)
      else reject(new Error((data && data.error) || 'SW error'))
    }
    ctrl.postMessage(message, [channel.port2])
  })
}

/** Fire-and-forget unregister. Errors are swallowed — nothing actionable
 *  to do if the SW already forgot it. */
export function unregisterDeck(deckId: string): void {
  if (!deckId) return
  postToSW({ type: 'unregister-deck', deckId }).catch(() => {})
}

/** Subscribe to "deck-missing" notifications from the SW (sent when a
 *  fetch arrives for a deckId the SW no longer knows about — e.g. after
 *  a SW idle restart). The handler should re-register the deck if it
 *  matches the currently-displayed one. */
export function onDeckMissing(handler: (deckId: string) => void): void {
  if (!('serviceWorker' in navigator)) return
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: string; deckId?: string } | undefined
    if (data && data.type === 'deck-missing' && data.deckId) {
      handler(data.deckId)
    }
  })
}

/**
 * Truncated SHA-256 of the .deck bytes — used as the URL fragment and
 * the deckId. 96 bits gives ~2^48 birthday-attack work to engineer a
 * collision, which is well above casual-attacker effort. URL length
 * (24 hex chars) is still short enough to be unobtrusive.
 */
export async function hashBlob(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', buf)
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (let i = 0; i < 12; i++) hex += bytes[i].toString(16).padStart(2, '0')
  return hex
}

/**
 * Thrown when a load is cancelled mid-decompression because the user
 * navigated away. Caller code should treat this as a quiet termination,
 * not an error to surface.
 */
export class LoadCancelled extends Error {
  constructor() {
    super('Load cancelled')
    this.name = 'LoadCancelled'
  }
}

/**
 * Validate the zip is a real deck, read every file into memory, and
 * register the file table with the Service Worker.
 */
export async function unpackAndRegister(
  blob: Blob,
  deckId: string,
  onProgress: (msg: string) => void,
  isCurrent?: () => boolean,
): Promise<DeckManifest> {
  const t = getT()
  const checkAlive = isCurrent || (() => true)

  const zip = await JSZip.loadAsync(blob)
  if (!checkAlive()) throw new LoadCancelled()

  const manifestEntry = zip.file('deck.json')
  const indexEntry = zip.file('index.html')
  if (!manifestEntry) throw new Error(t('errInvalidNoManifest'))
  if (!indexEntry) throw new Error(t('errInvalidNoIndex'))

  let manifest: DeckManifest
  try {
    const parsed = JSON.parse(await manifestEntry.async('string')) as DeckManifest
    manifest = parsed
  } catch {
    throw new Error(t('errInvalidJson'))
  }
  if (!manifest.name || typeof manifest.name !== 'string') {
    throw new Error(t('errInvalidNoName'))
  }

  if (onProgress) onProgress(t('statusReading'))
  const entries: [string, JSZip.JSZipObject][] = []
  zip.forEach((relPath, entry) => {
    if (!entry.dir) entries.push([relPath, entry])
  })
  // Decompress in batches so the main thread can paint between chunks.
  // BATCH_SIZE = 32 is empirical: small enough that one batch on
  // average commodity hardware completes within ~30ms (one frame
  // budget), large enough that loop and yield overhead don't dominate
  // for decks with many tiny files.
  const files: Record<string, Uint8Array> = {}
  const BATCH_SIZE = 32
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    if (!checkAlive()) throw new LoadCancelled()
    const batch = entries.slice(i, i + BATCH_SIZE)
    await Promise.all(
      batch.map(async ([relPath, entry]) => {
        files[relPath] = await entry.async('uint8array')
      }),
    )
    // Yield to the event loop so layout/paint can proceed.
    if (i + BATCH_SIZE < entries.length) {
      await new Promise<void>((r) => setTimeout(r, 0))
    }
  }
  if (!checkAlive()) throw new LoadCancelled()

  await ensureServiceWorker()
  if (onProgress) onProgress(t('statusHandoff'))
  await postToSW({ type: 'register-deck', deckId, files })
  return manifest
}
