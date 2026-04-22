import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import serveStatic from 'serve-static'

// Matches the CSP defined in deck-spec.md §4. Applied to author Decks only
// (everything served by this per-deck server). The Launcher is loaded via
// `win.loadFile` and uses its own meta CSP in src/renderer/index.html —
// don't try to keep these two in sync, they serve different threat models.
const DEFAULT_CSP =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; " +
  "connect-src 'self'"

export interface DeckServer {
  port: number
  url: string
  close(): Promise<void>
}

/**
 * Start a per-deck HTTP server bound to 127.0.0.1 on a random port.
 * Serves files from `rootDir` with the spec's default CSP applied.
 */
export function startDeckServer(rootDir: string): Promise<DeckServer> {
  const serve = serveStatic(rootDir, {
    index: ['index.html'],
    fallthrough: false,
    dotfiles: 'ignore',
  })

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Security-Policy', DEFAULT_CSP)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    // Pass a no-op finalhandler: any unresolved request just 404s.
    // serve-static's types are express-flavored; node's http types are a
    // structural superset for what it actually reads, so the casts are safe.
    serve(req as IncomingMessage & { url: string }, res as ServerResponse, (err: unknown) => {
      if (err && (err as { statusCode?: number }).statusCode) {
        res.statusCode = (err as { statusCode: number }).statusCode
      } else if (err) {
        res.statusCode = 500
      } else {
        res.statusCode = 404
      }
      res.end()
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      const port = addr.port
      resolve({
        port,
        url: `http://127.0.0.1:${port}/`,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res())
          }),
      })
    })
  })
}
