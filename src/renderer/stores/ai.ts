// AI-runtime state: streaming flag, unready reason, context-usage indicator.
//
// `streaming` is owned by the agent's lifecycle events; `unreadyReason`
// is probed against main on boot + after the Settings overlay closes.
// Both gate the composer's Send button (canSend = !streaming && !reason).

import { create } from 'zustand'
import type { AiUnreadyReason } from '#/main/ai/provider.ts'

export interface ContextUsage {
  tokens: number
  contextWindow: number
  warn: boolean
}

interface AiStore {
  streaming: boolean
  /** null = AI ready to stream. Otherwise a reason we got from main. */
  unreadyReason: AiUnreadyReason | null
  contextUsage: ContextUsage | null
  /** Sticky composer error — survives across re-renders until cleared.
   *  Populated by the agent's `deck:fatal` event or send-side failures. */
  error: string | null

  setStreaming: (v: boolean) => void
  setUnreadyReason: (r: AiUnreadyReason | null) => void
  setContextUsage: (u: ContextUsage | null) => void
  setError: (msg: string | null) => void

  /** Re-probe `settings:ai-readiness`. Called on boot and after the
   *  Settings overlay closes (the user may have added a key / fixed
   *  endpoint). */
  refreshReadiness: () => Promise<void>
}

export const useAiStore = create<AiStore>((set) => ({
  streaming: false,
  unreadyReason: null,
  contextUsage: null,
  error: null,
  setStreaming: (v) => set({ streaming: v }),
  setUnreadyReason: (r) => set({ unreadyReason: r }),
  setContextUsage: (u) => set({ contextUsage: u }),
  setError: (msg) => set({ error: msg }),
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
}))

/** Convenience selector. Components use it directly:
 *    const canSend = useAiStore(canSendSelector)  */
export function canSendSelector(s: AiStore): boolean {
  return !s.streaming && s.unreadyReason === null
}

// Boot probe.
void useAiStore.getState().refreshReadiness()
