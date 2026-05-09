// Chat list — pure mapping of `chatStore.nodes` to message bubbles and
// tool chips. No DOM mutation; React reconciles when the store updates.
//
// Auto-scroll: `useEffect` on `nodes` scrolls to bottom on any list
// change (append OR streaming-text patch) unless the user has manually
// scrolled away from the tail (within ~200px keeps auto-follow on;
// further away, we leave them where they are).

import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useChatStore, type ChatNode } from '#/renderer/stores/chat.ts'
import { useI18n } from '#/renderer/stores/i18n.ts'
import { Scroller } from '#/renderer/components/Scroller.tsx'
import { cn } from '#/renderer/lib/cn.ts'

export function ChatList() {
  const t = useI18n((s) => s.t)
  const nodes = useChatStore((s) => s.nodes)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const followingRef = useRef(true)

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    if (followingRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [nodes])

  const onScroll = () => {
    const el = scrollerRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    followingRef.current = distance < 200
  }

  // External-link click delegation (assistant Markdown carries
  // `data-external` from the preload's DOMPurify hook).
  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest?.('a[data-external]')
    if (!a) return
    const href = a.getAttribute('href')
    if (!href) return
    e.preventDefault()
    window.deck.openExternal?.(href)
  }

  const isEmpty = nodes.length === 0

  return (
    <Scroller scrollRef={scrollerRef} onScroll={onScroll} onClick={onClick}>
      <div className="flex flex-col gap-3.5 px-5 py-5" role="log" aria-live="polite">
        {isEmpty && <ChatEmpty />}
        {nodes.map((n) => (
          <ChatNodeView key={n.id} node={n} />
        ))}
      </div>
    </Scroller>
  )

  function ChatEmpty() {
    return (
      <div className="px-1 py-4 text-[13px] leading-relaxed text-ink-3">
        <div className="mb-2.5 text-[13px] font-semibold text-ink">{t('chat.empty.title')}</div>
        <div>{t('chat.empty.body')}</div>
        <ul className="mt-3 flex list-none flex-col gap-1.5 p-0 text-[12px] text-ink-4">
          {/* The shortcuts entry contains <span class="kbd"> markup, so
              we trust the dictionary string and dangerously-set it. */}
          <li dangerouslySetInnerHTML={{ __html: t('chat.empty.shortcuts') }} />
          <li>{t('chat.empty.dropTip')}</li>
        </ul>
      </div>
    )
  }
}

// Memoized so streaming `message_update` events (which mutate only the
// last assistant node's text) don't force re-renders of every prior
// node. ChatNode is structurally shared except where mutated, so a
// reference-equal `node` prop means nothing visible changed for that row.
const ChatNodeView = memo(function ChatNodeView({ node }: { node: ChatNode }) {
  if (node.kind === 'user') {
    return (
      <div className="flex flex-col items-end">
        <div className="max-w-[82%] whitespace-pre-wrap rounded-xl border border-line bg-surface px-3 py-2 text-[13px] leading-relaxed text-ink">
          {node.text}
        </div>
      </div>
    )
  }
  if (node.kind === 'assistant') {
    return <AssistantNode node={node} />
  }
  if (node.kind === 'tool') {
    return <ToolChip node={node} />
  }
  if (node.kind === 'error') {
    return (
      <div className="flex flex-col">
        <div
          className={cn(
            'whitespace-pre-wrap rounded-lg px-3 py-2.5 text-[13px] leading-relaxed',
            'border bg-[rgb(196_58_58/0.08)] border-[rgb(196_58_58/0.25)] text-[#c43a3a]',
            'dark:bg-[rgb(255_122_122/0.1)] dark:border-[rgb(255_122_122/0.3)] dark:text-[#ff9090]',
          )}
        >
          {node.text}
        </div>
      </div>
    )
  }
  return null
})

// Assistant bubble — the only node that runs Markdown through marked +
// DOMPurify on the preload side. Streaming pumps `message_update` events
// at 20-40Hz, each one growing `node.text`; without memoization that's a
// full marked.parse() per tick on text that's monotonically growing.
// Memoizing on `node.text` reuses the parsed HTML across the renders
// driven by `streaming`/sibling-store updates, leaving real work only
// when the text actually changed.
function AssistantNode({ node }: { node: Extract<ChatNode, { kind: 'assistant' }> }) {
  const html = useMemo(() => window.deck.renderMarkdown?.(node.text) ?? '', [node.text])
  // Show thinking only until the first answer chunk arrives — once
  // text is streaming, the answer is what the user wants to read.
  // For a thinking-only turn (toolCall with no text), `streaming` flips
  // to false at message_end and the whole node gets dropped by
  // `finalizeAssistant`, so this hides naturally.
  const showThinking = node.streaming && !node.text
  return (
    <div className="flex flex-col gap-2">
      {showThinking && <ThinkingBlock text={node.thinking} />}
      {node.text && (
        <div
          className={cn(
            'markdown-body text-[13px] leading-relaxed text-ink',
            node.streaming && 'after:content-["▍"] after:text-ink-3 after:animate-pulse',
          )}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  )
}

/**
 * Live thinking / reasoning panel. Rendered raw (no Markdown) so it
 * doesn't compete visually with the final answer below; capped height
 * with auto-pin so a long trace can't push the chat pane around. The
 * dot trio gives the user a visible cue during the gap between turn
 * start and the first reasoning chunk.
 */
function ThinkingBlock({ text }: { text: string }) {
  const t = useI18n((s) => s.t)
  const ref = useRef<HTMLDivElement>(null)
  // useLayoutEffect (not useEffect): we want the scroll to happen in
  // the same frame as the new content paint — otherwise text streaming
  // at 20-40Hz produces a visible "scroll lag" where the bottom edge
  // briefly pulls back before the next tick catches up.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [text])
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-bg-deep">
      <div className="flex items-center gap-2 px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-4">
        <span>{t('chat.thinking.label')}</span>
        <ThinkingDots />
      </div>
      {/* Cap height so a long reasoning trace doesn't push the chat
          pane around. Internal scroll auto-pins to the bottom (above). */}
      <div
        ref={ref}
        className="max-h-[140px] overflow-y-auto whitespace-pre-wrap border-t border-line px-2.5 py-1.5 font-mono text-[11px] leading-snug text-ink-2"
      >
        {text || t('chat.thinking.empty')}
      </div>
    </div>
  )
}

function ThinkingDots() {
  return (
    <span className="inline-flex items-center gap-0.5">
      <span className="size-1 rounded-full bg-ink-4 animate-pulse [animation-delay:0ms]" />
      <span className="size-1 rounded-full bg-ink-4 animate-pulse [animation-delay:200ms]" />
      <span className="size-1 rounded-full bg-ink-4 animate-pulse [animation-delay:400ms]" />
    </span>
  )
}

function ToolChip({ node }: { node: Extract<ChatNode, { kind: 'tool' }> }) {
  // Result text + pretty-printed args can each be ~MB for tool calls
  // like `read` against large files. Memoize on the source object so
  // sibling re-renders (parent ChatList re-render driven by streaming
  // text on a different node) skip the work. The <details> body always
  // renders into the DOM — even when collapsed — so this runs whether
  // or not the user has expanded it.
  const summary = useMemo(() => summarizeArgs(node.args), [node.args])
  const argsJson = useMemo(() => JSON.stringify(node.args, null, 2), [node.args])
  const resultText = useMemo(
    () => (node.result ? readResultText(node.result) : node.running ? '(running…)' : ''),
    [node.result, node.running],
  )
  return (
    <details className="overflow-hidden rounded-lg border border-line bg-surface font-mono text-[12px]">
      <summary className="grid cursor-pointer select-none grid-cols-[auto_auto_1fr_auto] items-center gap-2 px-2.5 py-2 hover:bg-line">
        <span
          className={cn(
            'size-2 shrink-0 rounded-full',
            node.running && 'bg-accent animate-pulse',
            !node.running && !node.isError && 'bg-[#2f855a]',
            !node.running && node.isError && 'bg-[#c43a3a]',
          )}
        />
        <span className="font-semibold text-ink">{node.toolName}</span>
        <span className="truncate text-ink-3">{summary}</span>
        <span className="text-[10px] text-ink-4">▸</span>
      </summary>
      <div className="border-t border-line bg-bg-deep px-2.5 py-2 text-[11px] text-ink-2">
        <div className="font-sans text-[10px] font-semibold uppercase tracking-wider text-ink-4">Arguments</div>
        <pre className="mt-0.5 mb-1.5 whitespace-pre-wrap">{argsJson}</pre>
        <div className="mt-1.5 font-sans text-[10px] font-semibold uppercase tracking-wider text-ink-4">Result</div>
        <pre className="mt-0.5 max-h-[260px] overflow-y-auto whitespace-pre-wrap">
          {resultText || '(no result text)'}
        </pre>
      </div>
    </details>
  )
}

function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const a = args as Record<string, unknown>
  if (typeof a.path === 'string') return a.path
  if (typeof a.name === 'string') return a.name
  const firstKey = Object.keys(a)[0]
  if (!firstKey) return ''
  const raw = String(a[firstKey] ?? '')
  return raw.length > 80 ? raw.slice(0, 80) + '…' : raw
}

function readResultText(result: unknown): string {
  if (!result) return ''
  const r = result as { content?: unknown }
  if (Array.isArray(r.content)) {
    return r.content
      .filter(
        (c): c is { type: 'text'; text: string } =>
          !!c &&
          typeof c === 'object' &&
          (c as { type?: unknown }).type === 'text' &&
          typeof (c as { text?: unknown }).text === 'string',
      )
      .map((c) => c.text)
      .join('\n')
  }
  return String(result)
}
