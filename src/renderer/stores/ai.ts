// AI-runtime state: streaming flag, unready reason, context-usage indicator.
//
// `streaming` is owned by the agent's lifecycle events; `unreadyReason`
// is probed against main on boot + after the Settings overlay closes.
// Both gate the composer's Send button (canSend = !streaming && !reason).

import { create } from 'zustand'
import type { AiUnreadyReason } from '#/main/ai/provider.ts'
import type { ProviderId } from '#/main/secrets.ts'
import { useAppStore } from '#/renderer/stores/app.ts'

export interface ContextUsage {
  tokens: number
  contextWindow: number
  warn: boolean
}

/** Identity of the currently-bound deck session (provider + whether it
 *  was resumed from disk vs. freshly minted this run + whether its
 *  resume key survives a deck reopen + whether the bind itself
 *  succeeded or this is a degraded placeholder after fatal). Mirrors
 *  the `deck:session_bound` ai-event. UI uses this to render
 *  provider-aware affordances (e.g. the resumed-CLI empty state,
 *  History button visibility). */
export interface BoundSession {
  provider: ProviderId
  resumed: boolean
  resumeSurvivesReopen: boolean
  /** True only when this is a placeholder emitted alongside
   *  `deck:fatal` because the bind failed. UI should treat the
   *  session as unusable — capability flags above are zero by
   *  convention but `degraded` makes the intent explicit. */
  degraded: boolean
}

interface AiStore {
  streaming: boolean
  /** null = AI ready to stream. Otherwise a reason we got from main. */
  unreadyReason: AiUnreadyReason | null
  contextUsage: ContextUsage | null
  /** Sticky composer error — survives across re-renders until cleared.
   *  Populated by the agent's `deck:fatal` event or send-side failures. */
  error: string | null
  /** True when the active deck has at least one persisted past session
   *  (other than the active one — though we don't try to distinguish
   *  here; the popover does). Drives the History button's disabled
   *  state so it doesn't open onto an empty list. */
  hasHistory: boolean
  /** Identity of the currently-bound deck session, or null when no
   *  session is bound (initial load, between switches). Set by the
   *  `deck:session_bound` event from main; cleared on session reset. */
  boundSession: BoundSession | null

  setStreaming: (v: boolean) => void
  setUnreadyReason: (r: AiUnreadyReason | null) => void
  setContextUsage: (u: ContextUsage | null) => void
  setError: (msg: string | null) => void
  setHasHistory: (v: boolean) => void
  setBoundSession: (s: BoundSession | null) => void

  /** Re-probe `settings:ai-readiness`. Called on boot and after the
   *  Settings overlay closes (the user may have added a key / fixed
   *  endpoint). */
  refreshReadiness: () => Promise<void>
  /** Re-probe `chats:list` for the active deck. Called on boot, on
   *  each `agent_end` (a fresh successful turn may have just promoted
   *  an empty session into a persisted one), and from popover delete
   *  callbacks. */
  refreshHasHistory: () => Promise<void>
}

export const useAiStore = create<AiStore>((set) => ({
  streaming: false,
  unreadyReason: null,
  contextUsage: null,
  error: null,
  hasHistory: false,
  boundSession: null,
  setStreaming: (v) => set({ streaming: v }),
  setUnreadyReason: (r) => set({ unreadyReason: r }),
  setContextUsage: (u) => set({ contextUsage: u }),
  setError: (msg) => set({ error: msg }),
  setHasHistory: (v) => set({ hasHistory: v }),
  setBoundSession: (s) => set({ boundSession: s }),
  refreshReadiness: async () => {
    try {
      const r = await window.deck.settings.aiReadiness()
      set({ unreadyReason: r?.ready ? null : (r?.reason ?? 'no-key') })
    } catch {
      // Couldn't reach main — leave the gate open so a real send surfaces
      // the underlying error rather than silently disabling the button.
      set({ unreadyReason: null })
    }
  },
  refreshHasHistory: async () => {
    try {
      const r = await window.deck.chats.list()
      set({ hasHistory: Array.isArray(r?.sessions) && r.sessions.length > 0 })
    } catch {
      // List failed — assume no history rather than mis-enabling the
      // button to a popover that will also fail.
      set({ hasHistory: false })
    }
  },
}))

/** Convenience selector. Components use it directly:
 *    const canSend = useAiStore(canSendSelector)  */
export function canSendSelector(s: AiStore): boolean {
  return !s.streaming && s.unreadyReason === null
}

// Boot probe.
void useAiStore.getState().refreshReadiness()
void useAiStore.getState().refreshHasHistory()

// Refresh history availability whenever a different deck becomes
// active — `chats:list` is deck-scoped, and the boot probe runs
// before any deck is loaded. Seed with whatever app state is already
// in the store (handles the case where a deck is restored before this
// module subscribes).
{
  let lastDeckPath: string | null = useAppStore.getState().deck?.sourcePath ?? null
  useAppStore.subscribe((s) => {
    const next = s.deck?.sourcePath ?? null
    if (next !== lastDeckPath) {
      lastDeckPath = next
      void useAiStore.getState().refreshHasHistory()
    }
  })
}

// Re-probe whenever the standalone Settings window closes — the user
// may have added or removed an API key.
window.deck.onAiReadinessRefresh?.(() => {
  void useAiStore.getState().refreshReadiness()
})
