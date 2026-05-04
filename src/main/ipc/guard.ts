import type { IpcMainInvokeEvent } from 'electron'
import { isChromeWebContents } from '#/main/window-registry.ts'

/**
 * Guard an `ipcMain.handle` callback so it only fires for our registered
 * chrome WebContents. Implements the `validateSender` pattern from
 * Electron's security checklist (§17): without it, any WebContents that
 * somehow gained access to `ipcRenderer` could invoke these handlers.
 *
 * Today our deckView has no preload and no `nodeIntegration`, so it can't
 * reach `ipcRenderer` at all — this turns that property from
 * configurational into structural. Handlers that fail the guard return
 * `null` (or the provided `rejected` fallback) instead of executing.
 */
export function chromeOnly<Args extends unknown[], R>(
  handler: (event: IpcMainInvokeEvent, ...args: Args) => R | Promise<R>,
  rejected?: R,
): (event: IpcMainInvokeEvent, ...args: Args) => R | Promise<R> | null {
  return (event, ...args) => {
    if (!isChromeWebContents(event.sender)) {
      // Don't crash the caller — just no-op. The renderer will never see
      // this branch in practice; the log is for dev debugging if we ever
      // misroute a message.
      console.warn('[ipc] rejected handler call from unknown sender', event.sender.id)
      return rejected ?? (null as R)
    }
    return handler(event, ...args)
  }
}
