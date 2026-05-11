// Module-level registry of "pending flush" callbacks, used by the
// Settings window to commit unsaved edits when main asks it to (today:
// the before-quit / close-window paths).
//
// Why a registry and not a React effect cleanup:
//
// React's useEffect cleanup must be synchronous — it cannot `await`. Our
// AiTab has a 1.5s debounced settings.json save AND an apiKey field
// that only commits to the OS keychain on blur. Both ride IPC. If the
// user quits during the debounce window or before blur fires, the
// cleanup phase fires-and-forgets the IPC and the renderer is torn down
// before the call dispatches — the edit is lost.
//
// Putting the flushers here lets the SettingsApp's flush IPC handler
// `await Promise.all(...)` over them, and main's close-window flow can
// `await` the IPC's reply before destroying the webContents.
//
// Each component subscribes via `registerFlusher(fn)` and gets an
// unsubscribe back; on unmount it calls the unsubscribe. The registry
// itself never iterates from outside — `flushAll()` is the only export
// that walks it. flushAll() runs every flusher to completion (one
// misbehaving flusher can't strand the others) but DOES NOT swallow
// errors — it returns them as a structured result so main can prompt
// the user before tearing the window down on a write that failed.

/** A flush callback. Resolves when the component's pending edit (if
 *  any) has been committed; rejects on unrecoverable error. The
 *  registry surfaces rejections to its caller — flushers must not
 *  swallow errors that the user would want to know about (e.g. a
 *  keychain write that failed). Returning quickly when there's nothing
 *  to flush is expected — flushers run on every quit / close-settings
 *  path. */
export type Flusher = () => Promise<void>

/** Aggregate outcome of a flushAll() round. `ok` is true iff every
 *  flusher resolved; `errors` carries the rejection messages so the
 *  caller can present them. The split lets main distinguish "nothing
 *  to commit / committed cleanly" from "tried to commit and failed",
 *  the second of which warrants a user prompt. */
export interface FlushResult {
  ok: boolean
  errors: string[]
}

const flushers = new Set<Flusher>()

/** Register a flusher. Returns an unsubscribe function the caller MUST
 *  invoke on unmount, otherwise stale flushers run forever. */
export function registerFlusher(fn: Flusher): () => void {
  flushers.add(fn)
  return () => {
    flushers.delete(fn)
  }
}

/** Run every registered flusher in parallel and report the aggregate
 *  result. Always resolves — never throws — even when individual
 *  flushers reject; their messages are returned in `errors`. */
export async function flushAll(): Promise<FlushResult> {
  const fns = [...flushers]
  const settled = await Promise.allSettled(fns.map((fn) => fn()))
  const errors: string[] = []
  for (const r of settled) {
    if (r.status === 'rejected') {
      errors.push(r.reason instanceof Error ? r.reason.message : String(r.reason))
    }
  }
  return { ok: errors.length === 0, errors }
}
