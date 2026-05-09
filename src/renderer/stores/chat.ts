// Chat transcript store — declarative replacement for the old vanilla
// `messageNodes`/`toolNodes` Maps + DOM mutation calls. Components render
// `messages.map(...)`; events from main mutate this store and React
// re-renders.
//
// Message identity:
//   - User messages have no stable id from main. We mint `u-<n>` locally.
//   - Assistant messages key on `timestamp` from the model, with a
//     `replay-<idx>` fallback used by `deck:history_replay`.
//   - Tool chips key on `toolCallId` (always present from pi-agent-core).
//
// We deliberately don't dedupe / reconcile — each event maps to a single
// store mutation (append / patch by id). The agent never sends "delete
// this message", so growth is monotonic until `deck:session_reset`.

import { create } from 'zustand'

export type ChatNode =
  | { kind: 'user'; id: string; text: string }
  | {
      kind: 'assistant'
      id: string
      text: string
      /**
       * Live thinking / reasoning text from the current turn. Cleared
       * on `finalizeAssistant` so the bubble collapses back to the
       * answer once the model is done — per product call, history
       * doesn't keep thinking around.
       */
      thinking: string
      streaming: boolean
      isError?: boolean
    }
  | { kind: 'tool'; id: string; toolCallId: string; toolName: string; args: unknown; result?: unknown; running: boolean; isError?: boolean }
  | { kind: 'error'; id: string; text: string }

interface ChatStore {
  /** Ordered list — what the chat-pane renders. */
  nodes: ChatNode[]
  /** Set when an assistant tool wrote to disk; flips a chained
   *  `reloadPreview()` once `agent_end` fires. */
  pendingReload: boolean

  /** Append a user message and return its id, so callers can roll it
   *  back via `removeNode` if the send is refused. */
  appendUser: (text: string) => string
  /** Remove a node by id. No-op if missing. Currently used only to roll
   *  back an optimistic user-message append when the agent refuses the
   *  send — node ids across kinds are namespaced (`u-` / `e-` / `t-` /
   *  replay keys) so this can't accidentally drop a different node. */
  removeNode: (id: string) => void
  /** Ensure an assistant node exists for `key`; create empty if missing.
   *  Returns the existing or new node so the caller can patch text. */
  ensureAssistant: (key: string) => void
  /** Append-or-replace assistant text by id. */
  patchAssistant: (key: string, text: string) => void
  /** Append-or-replace assistant thinking text by id. Used while the
   *  model streams reasoning content (separate from `text`). */
  patchAssistantThinking: (key: string, thinking: string) => void
  /** Mark assistant streaming=false. Drops the node entirely if it ended
   *  up with no text and no associated tool chips (a turn that emitted
   *  only toolCalls leaves an empty bubble; nicer to remove). Also
   *  clears `thinking` so the block hides on settle. */
  finalizeAssistant: (key: string) => void

  appendError: (text: string) => void

  appendTool: (toolCallId: string, toolName: string, args: unknown) => void
  finalizeTool: (toolCallId: string, result: unknown, isError: boolean) => void

  setPendingReload: (v: boolean) => void

  /** Wipe everything. Called on `deck:session_reset` and on session switch. */
  reset: () => void
}

// Monotonic counters for node ids that need to be unique across the
// session. We don't reuse `nodes.length` because removeNode can shrink
// it, so the next append could pick a length that collides with a
// surviving sibling (rare but the React reconciler hates it).
let userCounter = 0
let errorCounter = 0

export const useChatStore = create<ChatStore>((set) => ({
  nodes: [],
  pendingReload: false,

  appendUser: (text) => {
    const id = `u-${++userCounter}`
    set((s) => ({ nodes: [...s.nodes, { kind: 'user', id, text }] }))
    return id
  },

  removeNode: (id) =>
    set((s) => ({ nodes: s.nodes.filter((n) => n.id !== id) })),

  ensureAssistant: (key) =>
    set((s) => {
      if (s.nodes.some((n) => n.kind === 'assistant' && n.id === key)) return s
      return {
        nodes: [...s.nodes, { kind: 'assistant', id: key, text: '', thinking: '', streaming: true }],
      }
    }),

  patchAssistant: (key, text) =>
    set((s) => {
      let changed = false
      const next = s.nodes.map((n) => {
        if (n.kind !== 'assistant' || n.id !== key || n.text === text) return n
        changed = true
        return { ...n, text }
      })
      // Skip the state mutation when nothing actually changed — pi can
      // emit identical message_update payloads (post-stop snapshots),
      // and at 20-40Hz a no-op array swap still costs us a ChatList
      // re-render with an unchanged tree.
      return changed ? { nodes: next } : s
    }),

  patchAssistantThinking: (key, thinking) =>
    set((s) => {
      let changed = false
      const next = s.nodes.map((n) => {
        if (n.kind !== 'assistant' || n.id !== key || n.thinking === thinking) return n
        changed = true
        return { ...n, thinking }
      })
      return changed ? { nodes: next } : s
    }),

  finalizeAssistant: (key) =>
    set((s) => ({
      nodes: s.nodes.flatMap((n) => {
        if (n.kind !== 'assistant' || n.id !== key) return [n]
        // Drop empty assistant turns (only-toolCalls case).
        if (!n.text) return []
        // Clear thinking on settle: per product call we hide it when
        // the turn ends. Keeping the field on the node (vs. dropping
        // it) avoids a type union with/without `thinking` in callers.
        return [{ ...n, thinking: '', streaming: false }]
      }),
    })),

  appendError: (text) =>
    set((s) => {
      // Dedup the tail: pi's failure paths can fire `message_end` *and*
      // `agent_end` with the same errorMessage on the same assistant
      // turn (and `deck:fatal` overlaps with both in some setup-failure
      // cases). Showing one error chip per actual failure is the goal.
      const last = s.nodes[s.nodes.length - 1]
      if (last && last.kind === 'error' && last.text === text) return s
      return {
        nodes: [...s.nodes, { kind: 'error', id: `e-${++errorCounter}`, text }],
      }
    }),

  appendTool: (toolCallId, toolName, args) =>
    set((s) => {
      // Replay can produce toolResult before toolCall — refuse to dupe.
      if (s.nodes.some((n) => n.kind === 'tool' && n.toolCallId === toolCallId)) return s
      return {
        nodes: [
          ...s.nodes,
          { kind: 'tool', id: `t-${toolCallId}`, toolCallId, toolName, args, running: true },
        ],
      }
    }),

  finalizeTool: (toolCallId, result, isError) =>
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.kind === 'tool' && n.toolCallId === toolCallId ? { ...n, running: false, result, isError } : n,
      ),
    })),

  setPendingReload: (v) => set({ pendingReload: v }),

  reset: () => set({ nodes: [], pendingReload: false }),
}))
