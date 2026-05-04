// Shared application state — the last `app:state` payload broadcast from
// the main process. Each UI module reads it directly (live binding via
// `export let`) and reacts through `onStateChange` subscriptions. Modules
// that need to push mutations don't exist — state is owned by main, and
// updates always come back through the IPC `onState` stream below.

export const LS = {
  theme: 'deck:theme',
  lang: 'deck:lang',
  chatWidth: 'deck:chat-width',
}

/** Last-broadcast app state. Default matches the launcher-idle shape so
 *  early reads before the first IPC response are safe. */
export let state = {
  mode: 'launcher',
  subView: 'edit',
  deck: null,
  chatWidth: 532,
  loading: false,
  isFullScreen: false,
}

const listeners = new Set()

/** Register a callback to run after `state` is replaced. Returns an
 *  unsubscribe function. Callbacks run in registration order and receive
 *  the new state as their only argument. */
export function onStateChange(cb) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function setState(next) {
  state = next
  for (const cb of listeners) {
    try {
      cb(state)
    } catch (err) {
      // A misbehaving listener shouldn't take the whole UI down.
      console.error('[deck:ui] state listener threw', err)
    }
  }
}

/** One-shot pull of the current state (used on boot). */
export async function refreshState() {
  const s = await window.deck.getState()
  if (!s) return
  setState(s)
}

// One IPC subscription shared across modules. Registered at module load.
window.deck.onState((s) => {
  setState(s)
})
