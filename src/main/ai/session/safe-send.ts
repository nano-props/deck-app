import type { WebContents } from 'electron'

/**
 * Wrap `webContents.send` so we can no-op after the view is destroyed
 * without a try/catch at every call site.
 */
export function safeSend(sender: WebContents, channel: string, payload: unknown): void {
  if (sender.isDestroyed()) return
  try {
    sender.send(channel, payload)
  } catch {
    // Destroyed between isDestroyed() and send() during teardown races —
    // not worth surfacing.
  }
}
