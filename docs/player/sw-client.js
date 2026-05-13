// Service Worker registration, messaging, and the deck-zip → SW hand-off.
// JSZip is loaded as a UMD global from index.html — referenced as
// `window.JSZip` so this module doesn't need to import it.

const SW_URL = './sw.js'

let swReady = null

async function ensureServiceWorker() {
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
          await new Promise((resolve) => {
            navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })
          })
        }
        return reg
      })
  }
  return swReady
}

function postToSWInternal(message) {
  return new Promise((resolve, reject) => {
    const ctrl = navigator.serviceWorker.controller
    if (!ctrl) return reject(new Error('No active Service Worker.'))
    const channel = new MessageChannel()
    channel.port1.onmessage = (e) => {
      if (e.data && e.data.ok) resolve(e.data)
      else reject(new Error((e.data && e.data.error) || 'SW error'))
    }
    ctrl.postMessage(message, [channel.port2])
  })
}

// Fire-and-forget unregister. Used on transitions where we no longer
// need the SW to serve files for an old deck. Errors are swallowed —
// nothing actionable to do if the SW already forgot it.
export function unregisterDeck(deckId) {
  if (!deckId) return
  postToSWInternal({ type: 'unregister-deck', deckId }).catch(() => {})
}

/**
 * Subscribe to "deck-missing" notifications from the SW (sent when a
 * fetch arrives for a deckId the SW no longer knows about — e.g. after
 * a SW idle restart). The handler should re-register the deck if it
 * matches the currently-displayed one.
 */
export function onDeckMissing(handler) {
  if (!('serviceWorker' in navigator)) return
  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data
    if (data && data.type === 'deck-missing' && data.deckId) {
      handler(data.deckId)
    }
  })
}

// Truncated SHA-256 of the .deck bytes — used as the URL fragment and
// the deckId. 96 bits gives ~2^48 birthday-attack work to engineer a
// collision, which is well above casual-attacker effort. URL length
// (24 hex chars) is still short enough to be unobtrusive.
export async function hashBlob(blob) {
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
 *
 * @param {Blob} blob                          the .deck bytes
 * @param {string} deckId                      the precomputed content hash
 * @param {(msg: string) => void} onProgress   status callback
 * @param {() => boolean} [isCurrent]          if returns false at any
 *   yield point, the operation aborts with LoadCancelled. Lets a long
 *   decompression bail as soon as the user navigates away, freeing the
 *   main thread.
 * @returns {Promise<{name: string}>} the deck manifest
 */
export async function unpackAndRegister(blob, deckId, onProgress, isCurrent) {
  const checkAlive = isCurrent || (() => true)

  const zip = await window.JSZip.loadAsync(blob)
  if (!checkAlive()) throw new LoadCancelled()

  const manifestEntry = zip.file('deck.json')
  const indexEntry = zip.file('index.html')
  if (!manifestEntry) throw new Error('Invalid deck: missing deck.json at the root.')
  if (!indexEntry) throw new Error('Invalid deck: missing index.html at the root.')

  let manifest
  try {
    manifest = JSON.parse(await manifestEntry.async('string'))
  } catch (_err) {
    throw new Error('Invalid deck: deck.json is not valid JSON.')
  }
  if (!manifest.name || typeof manifest.name !== 'string') {
    throw new Error('Invalid deck: deck.json is missing the "name" field.')
  }

  if (onProgress) onProgress('Reading files…')
  const entries = []
  zip.forEach((relPath, entry) => {
    if (!entry.dir) entries.push([relPath, entry])
  })
  // Decompress in batches so the main thread can paint between chunks.
  // JSZip is pure JS and runs on the main thread; large decks (hundreds
  // of files) would otherwise block long enough to feel like a freeze.
  // BATCH_SIZE = 32 is empirical: small enough that one batch on
  // average commodity hardware completes within ~30ms (one frame budget),
  // large enough that loop and yield overhead don't dominate for decks
  // with many tiny files.
  const files = {}
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
      await new Promise((r) => setTimeout(r, 0))
    }
  }
  if (!checkAlive()) throw new LoadCancelled()

  await ensureServiceWorker()
  if (onProgress) onProgress('Handing off to Service Worker…')
  await postToSWInternal({ type: 'register-deck', deckId, files })
  return manifest
}
