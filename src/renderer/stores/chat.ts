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
  | { kind: 'assistant'; id: string; text: string; streaming: boolean; isError?: boolean }
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
  /** Mark assistant streaming=false. Drops the node entirely if it ended
   *  up with no text and no associated tool chips (a turn that emitted
   *  only toolCalls leaves an empty bubble; nicer to remove). */
  finalizeAssistant: (key: string) => void

  appendError: (text: string) => void

  appendTool: (toolCallId: string, toolName: string, args: unknown) => void
  finalizeTool: (toolCallId: string, result: unknown, isError: boolean) => void

  setPendingReload: (v: boolean) => void

  /** Wipe everything. Called on `deck:session_reset` and on session switch. */
  reset: () => void
}

let userCounter = 0

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
        nodes: [...s.nodes, { kind: 'assistant', id: key, text: '', streaming: true }],
      }
    }),

  patchAssistant: (key, text) =>
    set((s) => ({
      nodes: s.nodes.map((n) => (n.kind === 'assistant' && n.id === key ? { ...n, text } : n)),
    })),

  finalizeAssistant: (key) =>
    set((s) => ({
      nodes: s.nodes.flatMap((n) => {
        if (n.kind !== 'assistant' || n.id !== key) return [n]
        // Drop empty assistant turns (only-toolCalls case).
        if (!n.text) return []
        return [{ ...n, streaming: false }]
      }),
    })),

  appendError: (text) =>
    set((s) => ({
      nodes: [...s.nodes, { kind: 'error', id: `e-${s.nodes.length}-${Date.now()}`, text }],
    })),

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
