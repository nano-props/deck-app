import * as attachments from './attachments.js'

// Chat pane: message rendering, AI event dispatch, the composer submit
// path. Assumes the DOM nodes `chatList`, `input`, `sendBtn`, `abortBtn`,
// `chatStatus`, `composerForm`, `chatEmpty` already exist — they're in
// `app.html`'s deck-edit mode section.

const chatList = document.getElementById('chatList')
const chatEmpty = document.getElementById('chatEmpty')
const input = document.getElementById('input')
const sendBtn = document.getElementById('sendBtn')
const abortBtn = document.getElementById('abortBtn')
const chatStatus = document.getElementById('chatStatus')
const composerForm = document.getElementById('composer')

const messageNodes = new Map()
const toolNodes = new Map()
let isStreaming = false
let pendingReload = false

function setStreaming(s) {
  isStreaming = s
  sendBtn.disabled = s
  abortBtn.hidden = !s
  if (s) {
    chatStatus.classList.remove('err')
    chatStatus.textContent = 'Thinking…'
  } else if (!chatStatus.classList.contains('err')) {
    chatStatus.textContent = ''
    // Between turns, repaint the context-usage indicator (if we have one).
    renderContextUsage()
  }
}
function hideEmpty() {
  if (chatEmpty && !chatEmpty.hidden) chatEmpty.hidden = true
}
function scrollToEnd() {
  requestAnimationFrame(() => {
    chatList.scrollTop = chatList.scrollHeight
  })
}

function renderUserMessage(text) {
  hideEmpty()
  const wrap = document.createElement('div')
  wrap.className = 'msg user'
  const bodyEl = document.createElement('div')
  bodyEl.className = 'body'
  bodyEl.textContent = text
  wrap.appendChild(bodyEl)
  chatList.appendChild(wrap)
  scrollToEnd()
}
function ensureAssistantNode(key) {
  let node = messageNodes.get(key)
  if (node) return node
  hideEmpty()
  const wrap = document.createElement('div')
  wrap.className = 'msg assistant'
  const bodyEl = document.createElement('div')
  bodyEl.className = 'body markdown streaming'
  wrap.appendChild(bodyEl)
  chatList.appendChild(wrap)
  node = { wrap, body: bodyEl }
  messageNodes.set(key, node)
  scrollToEnd()
  return node
}

/**
 * Render assistant Markdown into the node's body. The parse + sanitize
 * happens in preload (see app-preload.js::renderMarkdown). We re-render
 * from scratch on every `message_update` — marked is ~0.1ms on a few-KB
 * assistant reply, cheaper than diffing.
 *
 * Falls back to textContent if preload didn't expose renderMarkdown (dev
 * reloads, older preload). That keeps the chat usable while degraded.
 */
function paintAssistantBody(bodyEl, text) {
  if (typeof window.deck?.renderMarkdown === 'function') {
    bodyEl.innerHTML = window.deck.renderMarkdown(text)
  } else {
    bodyEl.textContent = text
  }
}

// Links in assistant Markdown are tagged `data-external` by the preload's
// DOMPurify hook. Route clicks to the OS browser instead of navigating
// the chromeView — a chat click shouldn't blow away the app shell.
chatList.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[data-external]')
  if (!a) return
  const href = a.getAttribute('href')
  if (!href) return
  e.preventDefault()
  window.deck.openExternal?.(href)
})
function assistantText(m) {
  if (!m || !Array.isArray(m.content)) return ''
  return m.content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('')
}
function finalizeAssistant(key) {
  messageNodes.get(key)?.body.classList.remove('streaming')
}
function renderErrorMessage(text) {
  hideEmpty()
  const wrap = document.createElement('div')
  wrap.className = 'msg error'
  const bodyEl = document.createElement('div')
  bodyEl.className = 'body'
  bodyEl.textContent = text
  wrap.appendChild(bodyEl)
  chatList.appendChild(wrap)
  scrollToEnd()
}

function summarizeToolArgs(args) {
  if (!args || typeof args !== 'object') return ''
  if (typeof args.path === 'string') return args.path
  if (typeof args.name === 'string') return args.name
  const firstKey = Object.keys(args)[0]
  if (!firstKey) return ''
  const raw = String(args[firstKey] ?? '')
  return raw.length > 80 ? raw.slice(0, 80) + '…' : raw
}
function resultText(result) {
  if (!result) return ''
  if (Array.isArray(result.content)) {
    return result.content
      .filter((c) => c && c.type === 'text')
      .map((c) => c.text)
      .join('\n')
  }
  return String(result)
}
function renderToolChip(toolCallId, toolName, args) {
  hideEmpty()
  const wrap = document.createElement('div')
  wrap.className = 'tool running'
  const head = document.createElement('div')
  head.className = 'tool-head'
  const dot = document.createElement('span')
  dot.className = 'dot'
  const name = document.createElement('span')
  name.className = 'tool-name'
  name.textContent = toolName
  const summary = document.createElement('span')
  summary.className = 'tool-summary'
  summary.textContent = summarizeToolArgs(args)
  const toggle = document.createElement('span')
  toggle.className = 'tool-toggle'
  toggle.textContent = '▸'
  head.append(dot, name, summary, toggle)

  const bodyEl = document.createElement('div')
  bodyEl.className = 'tool-body'
  bodyEl.hidden = true
  const argsLabel = document.createElement('div')
  argsLabel.className = 'section-label'
  argsLabel.textContent = 'Arguments'
  const argsBlock = document.createElement('div')
  argsBlock.textContent = JSON.stringify(args, null, 2)
  const resLabel = document.createElement('div')
  resLabel.className = 'section-label'
  resLabel.textContent = 'Result'
  const resBlock = document.createElement('div')
  resBlock.textContent = '(running…)'
  bodyEl.append(argsLabel, argsBlock, resLabel, resBlock)

  head.addEventListener('click', () => {
    bodyEl.hidden = !bodyEl.hidden
    toggle.textContent = bodyEl.hidden ? '▸' : '▾'
  })

  wrap.append(head, bodyEl)
  chatList.appendChild(wrap)
  toolNodes.set(toolCallId, { wrap, resultBlock: resBlock })
  scrollToEnd()
}
function finalizeToolChip(toolCallId, result, isError) {
  const node = toolNodes.get(toolCallId)
  if (!node) return
  node.wrap.classList.remove('running')
  node.wrap.classList.add(isError ? 'error' : 'done')
  node.resultBlock.textContent = resultText(result) || '(no result text)'
}

/** Extract plain text from a UserMessage's content (string | (Text|Image)[]). */
function userMessageText(m) {
  if (typeof m.content === 'string') return m.content
  if (!Array.isArray(m.content)) return ''
  return m.content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('')
}

/**
 * Replay persisted messages on session start. Walks the array in order,
 * emitting the same DOM as a live run would have produced — user bubbles,
 * assistant bubbles (finalized, no cursor), tool chips with their results
 * filled in. Skips empty-text user messages that were only attachment
 * prelude so we don't render blank bubbles.
 *
 * This runs BEFORE any agent events for the current session, so tool ids
 * from the past transcript cannot collide with a future live run's ids.
 */
function replayHistory(messages) {
  if (!Array.isArray(messages)) return
  // Per-replay unique key. Live `message_*` events key on `timestamp`
  // (Date.now() from the provider); using a tagged string here keeps the
  // two key spaces disjoint — even if a historical timestamp happens to
  // equal a future live one, they won't collide into the same DOM node.
  let replayIdx = 0
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue
    if (m.role === 'user') {
      const text = userMessageText(m)
      if (text) renderUserMessage(text)
    } else if (m.role === 'assistant') {
      const key = `replay-${replayIdx++}`
      const node = ensureAssistantNode(key)
      paintAssistantBody(node.body, assistantText(m))
      finalizeAssistant(key)
      // Emit tool chips for every toolCall block in this assistant turn.
      // Results get filled in when we hit the matching toolResult below.
      if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if (block && block.type === 'toolCall') {
            renderToolChip(block.id, block.name, block.arguments ?? {})
          }
        }
      }
      if (m.stopReason === 'error' && m.errorMessage) {
        renderErrorMessage(m.errorMessage)
      }
    } else if (m.role === 'toolResult') {
      finalizeToolChip(m.toolCallId, { content: m.content }, !!m.isError)
    }
  }
  scrollToEnd()
}

window.deck.onAiEvent((ev) => {
  if (!ev || typeof ev !== 'object') return
  switch (ev.type) {
    case 'agent_start':
      setStreaming(true)
      break
    case 'agent_end':
      setStreaming(false)
      if (pendingReload) {
        pendingReload = false
        window.deck.reloadPreview()
      }
      break
    case 'message_start':
      if (ev.message?.role === 'assistant') ensureAssistantNode(ev.message.timestamp ?? Date.now())
      break
    case 'message_update':
      if (ev.message?.role === 'assistant') {
        const key = ev.message.timestamp ?? Date.now()
        const node = ensureAssistantNode(key)
        paintAssistantBody(node.body, assistantText(ev.message))
        scrollToEnd()
      }
      break
    case 'message_end':
      if (ev.message?.role === 'assistant') {
        const key = ev.message.timestamp ?? Date.now()
        const node = ensureAssistantNode(key)
        paintAssistantBody(node.body, assistantText(ev.message))
        finalizeAssistant(key)
        if (ev.message.stopReason === 'error' && ev.message.errorMessage) {
          renderErrorMessage(ev.message.errorMessage)
        }
      }
      break
    case 'tool_execution_start':
      renderToolChip(ev.toolCallId, ev.toolName, ev.args)
      break
    case 'tool_execution_end':
      finalizeToolChip(ev.toolCallId, ev.result, !!ev.isError)
      break
    case 'deck:file_change':
      pendingReload = true
      break
    case 'deck:fatal':
      setStreaming(false)
      chatStatus.classList.add('err')
      chatStatus.textContent = ev.error || 'AI error'
      renderErrorMessage(ev.error || 'AI error')
      break
    case 'deck:history_replay':
      replayHistory(ev.messages)
      break
    case 'deck:session_reset':
      chatList.querySelectorAll('.msg, .tool').forEach((el) => el.remove())
      messageNodes.clear()
      toolNodes.clear()
      if (chatEmpty) chatEmpty.hidden = false
      // Also drop any staged-but-unsent attachments — their relevance is
      // bound to the transcript we just cleared.
      attachments.clearAll()
      pendingReload = false
      chatStatus.classList.remove('err')
      chatStatus.textContent = ''
      contextUsage = null
      setStreaming(false)
      break
    case 'deck:context_usage':
      contextUsage = { tokens: ev.tokens, contextWindow: ev.contextWindow, warn: false }
      renderContextUsage()
      break
    case 'deck:context_warning':
      contextUsage = { tokens: ev.tokens, contextWindow: ev.contextWindow, warn: true }
      renderContextUsage()
      break
  }
})

// ---- Context usage indicator ------------------------------------------------
//
// Shown in chatStatus between turns. While a turn is in flight the chat
// status shows "Thinking…" (see setStreaming); we reapply the usage text
// once the status clears.

let contextUsage = null

function formatTokens(n) {
  if (n >= 1000) return `${Math.round(n / 100) / 10}k`
  return `${n}`
}

function renderContextUsage() {
  // Only paint when the status bar is otherwise idle (not streaming,
  // not showing an error). The setStreaming transition calls this too.
  if (!contextUsage) return
  if (chatStatus.classList.contains('err')) return
  if (chatStatus.textContent === 'Thinking…') return
  const { tokens, contextWindow, warn } = contextUsage
  const pct = contextWindow > 0 ? Math.round((tokens / contextWindow) * 100) : 0
  chatStatus.textContent = `${formatTokens(tokens)} / ${formatTokens(contextWindow)} (${pct}%)`
  chatStatus.classList.toggle('warn', warn)
}

async function sendMessage() {
  const userText = input.value.trim()
  const hasValidAttachments = attachments.hasValid()
  const hasRejectedOnly = !hasValidAttachments && attachments.hasAny()

  if (!userText && !hasValidAttachments) {
    // Nothing to send. If the only thing staged is rejected chips, nudge
    // the user — otherwise stay silent (Enter on an empty composer).
    if (hasRejectedOnly) {
      chatStatus.classList.add('err')
      chatStatus.textContent = 'Remove the invalid attachments before sending.'
    }
    return
  }

  chatStatus.classList.remove('err')

  let attachmentBlock = ''
  if (hasValidAttachments) {
    try {
      chatStatus.textContent = 'Attaching…'
      const r = await attachments.flush()
      attachmentBlock = r.block
    } catch (e) {
      chatStatus.classList.add('err')
      chatStatus.textContent = e?.message || String(e)
      return
    }
  }

  const fullText = attachmentBlock ? (userText ? `${attachmentBlock}\n\n${userText}` : attachmentBlock) : userText
  if (!fullText.trim()) return // defense — shouldn't happen after the guard above

  input.value = ''
  renderUserMessage(fullText)
  chatStatus.textContent = ''
  try {
    const res = await window.deck.aiSend(fullText)
    if (!res?.ok) {
      chatStatus.classList.add('err')
      chatStatus.textContent = res?.error || 'Send failed'
    }
  } catch (e) {
    chatStatus.classList.add('err')
    chatStatus.textContent = e?.message || String(e)
  }
}

composerForm.addEventListener('submit', (e) => {
  e.preventDefault()
  if (!isStreaming) void sendMessage()
})
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !e.isComposing) {
    e.preventDefault()
    if (!isStreaming) void sendMessage()
  } else if (e.key === 'Escape' && isStreaming) {
    e.preventDefault()
    void window.deck.aiAbort()
  }
})
abortBtn.addEventListener('click', () => window.deck.aiAbort())
