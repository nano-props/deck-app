/// <reference lib="WebWorker" />

// Service Worker: serves files for registered decks from in-memory zips.
// URL shape: <scope>/deck/<deckId>/<path-inside-deck>
//
// Decks are registered via postMessage from the page. Files are stored
// as Uint8Array; responses set Content-Type from the file extension.
//
// Built as a CLASSIC worker (no `{type: 'module'}`) — see
// vite.web.config.ts for the entry pinning. Rollup emits one file at
// `dist/web/sw.js` so the registration URL stays a literal in
// player/sw-client.ts.

export {}

declare const self: ServiceWorkerGlobalScope

interface RegisterMessage {
  type: 'register-deck'
  deckId: string
  files: Record<string, Uint8Array>
}
interface UnregisterMessage {
  type: 'unregister-deck'
  deckId: string
}
type IncomingMessage = RegisterMessage | UnregisterMessage

const decks = new Map<string, Record<string, Uint8Array>>()

// decodeURIComponent throws URIError on malformed input (e.g. a path
// segment containing a stray "%"). Treat undecodable paths as opaque —
// returning the original string lets the file table lookup just miss
// and produce a clean 404 instead of a broken fetch handler.
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

self.addEventListener('install', (event) => {
  // Activate immediately so the first deck load doesn't require a refresh.
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  // Take control of already-open clients (the page that just registered us).
  event.waitUntil(self.clients.claim())
})

self.addEventListener('message', (event) => {
  const data = event.data as IncomingMessage | undefined
  const ports = event.ports
  const reply = ports && ports[0]
  const ok = (extra?: Record<string, unknown>) =>
    reply && reply.postMessage({ ok: true, ...(extra || {}) })
  const fail = (error: string) => reply && reply.postMessage({ ok: false, error })

  if (!data || typeof data !== 'object') return fail('Bad message')

  if (data.type === 'register-deck') {
    if (!data.deckId || !data.files) return fail('Missing deckId or files')
    decks.set(data.deckId, data.files)
    return ok()
  }
  if (data.type === 'unregister-deck') {
    decks.delete(data.deckId)
    return ok()
  }
  return fail('Unknown message type: ' + (data as { type: string }).type)
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin) return

  const scopePath = new URL(self.registration.scope).pathname
  const deckRoot = scopePath + 'deck/'

  // Case 1: request is already addressed to /deck/<id>/<path>.
  if (url.pathname.startsWith(deckRoot)) {
    const rest = url.pathname.slice(deckRoot.length)
    const slash = rest.indexOf('/')
    if (slash < 0) return
    const deckId = rest.slice(0, slash)
    let filePath = rest.slice(slash + 1)
    if (!filePath || filePath.endsWith('/')) filePath += 'index.html'
    filePath = safeDecode(filePath)
    event.respondWith(serveDeckFile(event, deckId, filePath))
    return
  }

  // Case 2: a deck page made a same-origin request with an absolute
  // path (e.g. <link href="/_next/foo.css"> from a Next.js export).
  // Resolve the deck via the requesting client's URL — that client is
  // the iframe located at /deck/<id>/index.html, so we can extract <id>
  // and treat the absolute path as deck-relative.
  event.respondWith(handleAbsoluteFromDeck(event, deckRoot))
})

async function handleAbsoluteFromDeck(event: FetchEvent, deckRoot: string): Promise<Response> {
  let clientUrl: string | null = null
  if (event.clientId) {
    const client = await self.clients.get(event.clientId)
    if (client) clientUrl = client.url
  }
  // Subresource requests in some browsers report no clientId; fall back
  // to the Referer header, which the iframe sends as its own URL.
  if (!clientUrl) {
    const referer = event.request.referrer
    if (referer) clientUrl = referer
  }
  if (!clientUrl) return fetch(event.request)

  const ref = new URL(clientUrl)
  if (ref.origin !== self.location.origin) return fetch(event.request)
  if (!ref.pathname.startsWith(deckRoot)) return fetch(event.request)

  const after = ref.pathname.slice(deckRoot.length)
  const slash = after.indexOf('/')
  if (slash < 0) return fetch(event.request)
  const deckId = after.slice(0, slash)

  const url = new URL(event.request.url)
  // Strip the leading slash so the path is relative to the deck root.
  let filePath = url.pathname.replace(/^\/+/, '')
  filePath = safeDecode(filePath)
  if (!filePath || filePath.endsWith('/')) filePath += 'index.html'

  return serveDeckFile(event, deckId, filePath)
}

async function serveDeckFile(event: FetchEvent, deckId: string, filePath: string): Promise<Response> {
  const files = decks.get(deckId)
  if (!files) {
    // The SW may have been restarted by the browser since the deck was
    // registered (idle timeout, app refresh, etc.). Notify all
    // controlled clients so they can re-register the deck on demand.
    // waitUntil keeps the SW alive long enough for the postMessage to
    // actually leave — without it the SW could be evicted right after
    // returning the 404 and the notification would be lost.
    event.waitUntil(notifyDeckMissing(deckId))
    return new Response('Deck not registered', { status: 404 })
  }
  const request = event.request
  const bytes = files[filePath]
  if (!bytes) return new Response('Not found: ' + filePath, { status: 404 })

  const total = bytes.byteLength
  // Files arrive over postMessage from the page, where they were freshly
  // allocated as plain Uint8Array — so the underlying buffer is always
  // an ArrayBuffer, never a SharedArrayBuffer. Slice into a fresh
  // ArrayBuffer to satisfy Response's BodyInit constraint.
  const fullBuffer: ArrayBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + total,
  ) as ArrayBuffer
  const contentType = contentTypeFor(filePath)
  // Most deck files are addressed by a content-hashed deckId, so the
  // bytes at any given URL never change. We mark them immutable so the
  // browser can serve from disk cache without round-tripping the SW.
  //
  // HTML is the exception: navigating back to a previously-opened deck
  // may happen AFTER we've unregistered it from the SW. If the browser
  // had a cached HTML response, it would render shell HTML whose
  // subresource requests then 404 from the SW. no-cache forces the
  // browser to revalidate (i.e. consult the SW), which guarantees
  // either a live deck or a clean miss.
  const isHtml = contentType.startsWith('text/html')
  const cacheControl = isHtml ? 'no-cache' : 'public, max-age=31536000, immutable'

  // Honor Range requests so <video>/<audio> in decks can seek.
  const rangeHeader = request.headers.get('Range')
  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader)
    if (match) {
      const start = match[1] === '' ? 0 : Number(match[1])
      const end = match[2] === '' ? total - 1 : Number(match[2])
      if (
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        start >= 0 &&
        end >= start &&
        start < total
      ) {
        const clampedEnd = Math.min(end, total - 1)
        const slice = fullBuffer.slice(start, clampedEnd + 1)
        return new Response(slice, {
          status: 206,
          headers: new Headers({
            'Content-Type': contentType,
            'Content-Length': String(clampedEnd - start + 1),
            'Content-Range': 'bytes ' + start + '-' + clampedEnd + '/' + total,
            'Accept-Ranges': 'bytes',
            'Cache-Control': cacheControl,
          }),
        })
      }
      // Unsatisfiable range.
      return new Response(null, {
        status: 416,
        headers: new Headers({ 'Content-Range': 'bytes */' + total }),
      })
    }
  }

  return new Response(fullBuffer, {
    status: 200,
    headers: new Headers({
      'Content-Type': contentType,
      'Content-Length': String(total),
      'Accept-Ranges': 'bytes',
      'Cache-Control': cacheControl,
    }),
  })
}

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  wasm: 'application/wasm',
}

function contentTypeFor(filePath: string): string {
  const dot = filePath.lastIndexOf('.')
  if (dot < 0) return 'application/octet-stream'
  const ext = filePath.slice(dot + 1).toLowerCase()
  return TYPES[ext] || 'application/octet-stream'
}

// Coalesce notifications: only message clients once per deckId per
// "missing run". A page that gets a flurry of 404s from a single
// missing deck registration will only be told once.
const recentlyNotified = new Set<string>()
async function notifyDeckMissing(deckId: string): Promise<void> {
  if (recentlyNotified.has(deckId)) return
  recentlyNotified.add(deckId)
  // Reset after 2 seconds — long enough to absorb a burst of subresource
  // 404s, short enough that a later genuine miss still gets through.
  setTimeout(() => recentlyNotified.delete(deckId), 2000)

  const clients = await self.clients.matchAll({ includeUncontrolled: false })
  for (const client of clients) {
    client.postMessage({ type: 'deck-missing', deckId })
  }
}
