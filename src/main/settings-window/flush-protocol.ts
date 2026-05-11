// Pre-close flush protocol for the Settings BrowserWindow.
//
// React's useEffect cleanup must be synchronous, so any IPC kicked off
// from there frequently races the renderer teardown and gets dropped
// — which means a debounced settings.json save or an un-blurred apiKey
// edit can be lost if the user quits at the wrong moment. We work
// around that by giving main an explicit "renderer, please commit
// pending edits, await me" handshake. SettingsApp registers flushers
// in `flush-registry.ts`; main triggers them via this protocol before
// destroying the window.
//
// Wire format:
//   renderer → main:  app:settings-window-ready              (one-shot,
//                                                             on first
//                                                             React
//                                                             commit)
//   main → renderer:  app:settings-window-flush              (requestId)
//   renderer → main:  app:settings-window-flush-done:<id>    (FlushResult)
//
// The reply channel is per-request so concurrent / stale acks can't
// cross-talk. Main hard-caps every wait so a stuck renderer can't
// hang app-quit forever.
//
// Two timing concerns this protocol solves:
//
//   1. did-finish-load fires after HTML+JS load, BEFORE React's first
//      commit and BEFORE any tab's `registerFlusher` runs. Sending the
//      flush IPC at that point would race an empty registry and silently
//      drop the user's pending edits. The ready handshake lets main
//      wait until the registry is actually populated.
//
//   2. Flushers can fail (keychain unavailable, IPC rejection). The
//      ack now carries the aggregate FlushResult so callers can warn
//      the user instead of silently destroying the window with a
//      not-actually-saved key in the input box.

import { dialog, ipcMain, type BrowserWindow, type WebContents } from 'electron'
import { t } from '#/main/i18n/index.ts'

/** In practice the flush is two IPCs (settings.json + keychain) — both
 *  finish in well under 100ms. The cap protects against a stuck IPC
 *  hanging the quit / close path forever. */
const FLUSH_TIMEOUT_MS = 1500

/** Wait this long for the renderer's ready ack before giving up and
 *  flushing anyway. Generous because module-load → React-commit can
 *  take a bit on cold start; tight enough that quitting an
 *  already-broken renderer doesn't drag. */
const READY_TIMEOUT_MS = 2000

/** Aggregate flush outcome forwarded by preload from
 *  `flush-registry.ts`. `errors` is empty on the happy path. */
export interface FlushResult {
  ok: boolean
  errors: string[]
}

// Track which webContents have signalled "React is mounted, flushers
// have registered". Keyed by webContents.id. Cleared on close. Used by
// `flushSettingsWindow` to decide whether to wait for ready before
// sending the flush IPC.
const readyWcIds = new Set<number>()
// Pending one-shot ready waiters per webContents id. Resolved by the
// 'app:settings-window-ready' listener below.
const readyWaiters = new Map<number, Array<() => void>>()

// Allowlist of webContents ids permitted to drive this protocol.
// Populated by `trustSettingsWindow` from the Settings BrowserWindow
// factory; cleared on close. Other chrome WCs (deck AppWindow chromes)
// share the same preload and could in principle send these IPCs, but
// they have no reason to — gate strictly so a stray send can't pollute
// the ready set or fake a flush ack.
const trustedWcIds = new Set<number>()

/** Mark a WebContents as the (or a) Settings window's renderer. Only
 *  trusted ids can populate `readyWcIds` or send a flush ack. */
export function trustSettingsWindow(wcId: number): void {
  trustedWcIds.add(wcId)
}

ipcMain.on('app:settings-window-ready', (event) => {
  const id = event.sender.id
  if (!trustedWcIds.has(id)) {
    console.warn('[settings-window] ready ignored from untrusted wc', id)
    return
  }
  readyWcIds.add(id)
  const waiters = readyWaiters.get(id)
  if (waiters) {
    readyWaiters.delete(id)
    for (const w of waiters) w()
  }
})

/** Call from the window's `closed` handler so we don't leak entries
 *  for the next opened Settings window (which gets a fresh wcId, but
 *  defensive cleanup is cheap). Also drains any in-flight ready
 *  waiters so they resolve immediately rather than blocking the close
 *  path for the full READY_TIMEOUT_MS. */
export function forgetSettingsWindowReady(wcId: number): void {
  trustedWcIds.delete(wcId)
  readyWcIds.delete(wcId)
  const waiters = readyWaiters.get(wcId)
  readyWaiters.delete(wcId)
  if (waiters) for (const w of waiters) w()
}

function awaitRenderer(wc: WebContents): Promise<void> {
  if (readyWcIds.has(wc.id)) return Promise.resolve()
  return new Promise((resolve) => {
    const id = wc.id
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Drop our entry from the waiter list (others may still be
      // waiting on the same wc — concurrent flushSettingsWindow calls
      // are guarded against in index.ts but be defensive).
      const list = readyWaiters.get(id)
      if (list) {
        const idx = list.indexOf(finish)
        if (idx >= 0) list.splice(idx, 1)
        if (list.length === 0) readyWaiters.delete(id)
      }
      resolve()
    }
    const list = readyWaiters.get(id) ?? []
    list.push(finish)
    readyWaiters.set(id, list)
    const timer = setTimeout(() => {
      console.warn('[settings-window] ready handshake timed out — flushing anyway')
      finish()
    }, READY_TIMEOUT_MS)
  })
}

/**
 * Ask the renderer to commit any pending edits. Resolves when
 * SettingsApp acks back, or after FLUSH_TIMEOUT_MS — whichever first.
 *
 * If the renderer hasn't yet signalled `ready`, waits for that first
 * (with its own bounded timeout) so a quit triggered between
 * `did-finish-load` and React's first commit doesn't race past an
 * empty flusher registry.
 *
 * Caller is responsible for guarding against reentrant invocations (a
 * second flush during the first one's IPC round-trip would invoke
 * every flusher fn twice). The window's `close` handler in `index.ts`
 * uses a `flushing` flag for this.
 */
export async function flushSettingsWindow(win: BrowserWindow): Promise<FlushResult> {
  const wc = win.webContents
  if (wc.isDestroyed()) {
    // No renderer to talk to.
    return { ok: true, errors: [] }
  }
  // Wait for the React tree to be mounted before sending the flush IPC.
  // If it never readies (renderer crash, infinite-loading network call
  // before any module evaluates), we time out and proceed — same idiom
  // as the flush itself.
  await awaitRenderer(wc)
  if (wc.isDestroyed()) return { ok: true, errors: [] }

  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const ackChannel = `app:settings-window-flush-done:${requestId}`
  return new Promise<FlushResult>((resolve) => {
    let settled = false
    const finish = (result: FlushResult) => {
      if (settled) return
      settled = true
      ipcMain.removeListener(ackChannel, ackListener)
      clearTimeout(timer)
      resolve(result)
    }
    const ackListener = (event: Electron.IpcMainEvent, result?: FlushResult) => {
      // Only the window we sent the request to may answer. Without
      // this, any chrome WC sharing our preload could spoof an early
      // `{ ok: true }` ack and sail past a real flush failure.
      if (event.sender.id !== wc.id) {
        // Re-attach the listener — this stray send wasn't ours, but
        // the genuine ack may still arrive.
        ipcMain.once(ackChannel, ackListener)
        return
      }
      finish(result ?? { ok: true, errors: [] })
    }
    ipcMain.once(ackChannel, ackListener)
    const timer = setTimeout(() => {
      console.warn('[settings-window] flush timed out — proceeding to close')
      // Treat timeout as success for close-path control flow: we don't
      // know whether anything was actually saved, but we also don't
      // have anything actionable to tell the user, and blocking quit
      // forever is worse.
      finish({ ok: true, errors: [] })
    }, FLUSH_TIMEOUT_MS)
    try {
      wc.send('app:settings-window-flush', requestId)
    } catch {
      // Send failed (window torn down between checks). Resolve so the
      // close path can proceed.
      finish({ ok: true, errors: [] })
    }
  })
}

/**
 * Surface flush errors to the user with a non-blocking native dialog.
 * Called by the close handler when `flushSettingsWindow` returned
 * `ok: false`. Information-only ("OK") rather than a "Cancel close"
 * choice — by the time we know the write failed, the user has already
 * intentionally closed/quit, and blocking the close on a transient
 * keychain glitch creates worse UX than telling them and moving on.
 *
 * Always parentless: the Settings window is about to be destroyed
 * (the caller closes it on the next tick), and a modal dialog
 * parented to a window-that's-going-away vanishes with its parent
 * before the user can read it.
 */
export function notifyFlushFailed(errors: string[]): void {
  const detail = errors.join('\n') || 'Unknown error'
  console.error('[settings-window] flush errors on close:', detail)
  // showMessageBox is async; we deliberately fire-and-forget so the
  // close path isn't blocked on the user dismissing the dialog.
  void dialog.showMessageBox({
    type: 'warning',
    title: t('settings.flushFailed.title'),
    message: t('settings.flushFailed.message'),
    detail,
    buttons: [t('dialog.ok')],
    defaultId: 0,
  })
}
