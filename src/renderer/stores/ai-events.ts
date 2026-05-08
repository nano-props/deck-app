// AI event bridge — funnels every `ai:event` from main into the right
// store mutations. Imported once from main.tsx for its side effect.
//
// Replaces the old chat-events.js switch statement; the routing logic is
// the same, just dispatched into zustand stores instead of imperative
// DOM calls.

import { useAiStore } from '#/renderer/stores/ai.ts'
import { useAttachments } from '#/renderer/stores/attachments.ts'
import { useChatStore } from '#/renderer/stores/chat.ts'
import { getT } from '#/renderer/stores/i18n.ts'
import type { AiEvent, AssistantMessageRef, HistoryMessage } from '#/renderer/deck.d.ts'

interface TextBlock {
  type: 'text'
  text: string
}

interface ToolCallBlock {
  type: 'toolCall'
  id: string
  name: string
  arguments?: unknown
}

function isTextBlock(c: unknown): c is TextBlock {
  return (
    !!c &&
    typeof c === 'object' &&
    (c as { type?: unknown }).type === 'text' &&
    typeof (c as { text?: unknown }).text === 'string'
  )
}

function isToolCallBlock(c: unknown): c is ToolCallBlock {
  return (
    !!c &&
    typeof c === 'object' &&
    (c as { type?: unknown }).type === 'toolCall' &&
    typeof (c as { id?: unknown }).id === 'string' &&
    typeof (c as { name?: unknown }).name === 'string'
  )
}

function assistantText(m: AssistantMessageRef): string {
  if (!m || !Array.isArray(m.content)) return ''
  return m.content
    .filter(isTextBlock)
    .map((c) => c.text)
    .join('')
}

function userMessageText(m: HistoryMessage): string {
  if (typeof m.content === 'string') return m.content
  if (!Array.isArray(m.content)) return ''
  return m.content
    .filter(isTextBlock)
    .map((c) => c.text)
    .join('')
}

/**
 * Replay persisted messages on session start. Walks the array in order,
 * emitting the same store mutations a live run would have produced.
 *
 * Per-replay unique key. Live `message_*` events key on `timestamp`
 * (Date.now() from the provider); using a tagged string here keeps the
 * two key spaces disjoint — even if a historical timestamp equals a
 * future live one, they won't collide.
 */
function replayHistory(messages: HistoryMessage[]) {
  if (!Array.isArray(messages)) return
  const chat = useChatStore.getState()
  let replayIdx = 0
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue
    if (m.role === 'user') {
      const text = userMessageText(m)
      if (text) chat.appendUser(text)
    } else if (m.role === 'assistant') {
      const key = `replay-${replayIdx++}`
      chat.ensureAssistant(key)
      chat.patchAssistant(key, assistantText(m as AssistantMessageRef))
      chat.finalizeAssistant(key)
      if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if (isToolCallBlock(block)) {
            chat.appendTool(block.id, block.name, block.arguments ?? {})
          }
        }
      }
      if (m.stopReason === 'error' && m.errorMessage) {
        chat.appendError(m.errorMessage)
      }
    } else if (m.role === 'toolResult') {
      chat.finalizeTool(m.toolCallId ?? '', { content: m.content }, !!m.isError)
    }
  }
}

window.deck.onAiEvent((ev: AiEvent) => {
  if (!ev || typeof ev !== 'object') return
  const ai = useAiStore.getState()
  const chat = useChatStore.getState()

  switch (ev.type) {
    case 'agent_start':
      ai.setError(null)
      ai.setStreaming(true)
      break
    case 'agent_end':
      ai.setStreaming(false)
      if (chat.pendingReload) {
        chat.setPendingReload(false)
        void window.deck.reloadPreview().catch(() => {})
      }
      break
    case 'message_start':
      if (ev.message?.role === 'assistant') {
        chat.ensureAssistant(String(ev.message.timestamp ?? Date.now()))
      }
      break
    case 'message_update':
      if (ev.message?.role === 'assistant') {
        const key = String(ev.message.timestamp ?? Date.now())
        chat.ensureAssistant(key)
        chat.patchAssistant(key, assistantText(ev.message))
      }
      break
    case 'message_end':
      if (ev.message?.role === 'assistant') {
        const key = String(ev.message.timestamp ?? Date.now())
        chat.ensureAssistant(key)
        chat.patchAssistant(key, assistantText(ev.message))
        chat.finalizeAssistant(key)
        if (ev.message.stopReason === 'error' && ev.message.errorMessage) {
          chat.appendError(ev.message.errorMessage)
        }
      }
      break
    case 'tool_execution_start':
      chat.appendTool(ev.toolCallId, ev.toolName, ev.args)
      break
    case 'tool_execution_end':
      chat.finalizeTool(ev.toolCallId, ev.result, !!ev.isError)
      break
    case 'deck:file_change':
      chat.setPendingReload(true)
      break
    case 'deck:fatal': {
      ai.setStreaming(false)
      const msg = ev.error || getT()('chat.status.aiError')
      ai.setError(msg)
      chat.appendError(msg)
      break
    }
    case 'deck:history_replay':
      replayHistory(ev.messages)
      break
    case 'deck:session_reset':
      chat.reset()
      useAttachments.getState().clearAll()
      ai.setError(null)
      ai.setContextUsage(null)
      ai.setStreaming(false)
      break
    case 'deck:context_usage':
      ai.setContextUsage({ tokens: ev.tokens, contextWindow: ev.contextWindow, warn: false })
      break
    case 'deck:context_warning':
      ai.setContextUsage({ tokens: ev.tokens, contextWindow: ev.contextWindow, warn: true })
      break
  }
})
