import { rm } from 'node:fs/promises'
import type { BrowserWindow } from 'electron'
import type { DeckServer } from '#/main/server.ts'
import type { DeckManifest } from '#/main/deck-types.ts'

export interface DeckSession {
  window: BrowserWindow
  server: DeckServer
  rootDir: string
  manifest: DeckManifest
  /** If true, dispose() will delete rootDir. Set for temp extractions only. */
  ownsRootDir: boolean
}

/**
 * Tracks the 1:1 mapping between a BrowserWindow and the deck it is
 * showing (server + temp dir). When a window closes, the associated
 * server is stopped and the temp dir deleted.
 */
class SessionManager {
  private sessions = new Map<number, DeckSession>()

  register(session: DeckSession): void {
    const id = session.window.id
    this.sessions.set(id, session)

    session.window.once('closed', () => {
      void this.dispose(id)
    })
  }

  get(windowId: number): DeckSession | undefined {
    return this.sessions.get(windowId)
  }

  get size(): number {
    return this.sessions.size
  }

  /**
   * Idempotent: safe to call multiple times with the same id. On `before-quit`
   * the window's own 'closed' listener and `disposeAll` may both race to
   * dispose the same session; the synchronous `sessions.delete` below, paired
   * with JS's single-threaded event loop, guarantees only the first caller
   * performs the server.close / rm — no lock needed.
   */
  private async dispose(windowId: number): Promise<void> {
    const session = this.sessions.get(windowId)
    if (!session) return
    this.sessions.delete(windowId)

    await session.server.close().catch(() => {})
    if (session.ownsRootDir) {
      await rm(session.rootDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  /**
   * Dispose every live session without waiting for window 'closed' events.
   * Used from the app's `before-quit` handler so we can flush servers and
   * temp dirs before exit. Routes through the same `dispose` path as the
   * per-window 'closed' listener, so the cleanup semantics are identical.
   */
  async disposeAll(): Promise<void> {
    const ids = [...this.sessions.keys()]
    await Promise.all(ids.map((id) => this.dispose(id)))
  }
}

export const sessionManager = new SessionManager()
