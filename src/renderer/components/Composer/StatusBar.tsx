import { useEffect, useState } from 'react'
import { useAiStore } from '#/renderer/stores/ai.ts'
import { useChatStore } from '#/renderer/stores/chat.ts'
import { useI18n } from '#/renderer/stores/i18n.ts'
import { cn } from '#/renderer/lib/cn.ts'
import { formatNumber, formatTokens } from '#/renderer/components/Composer/format.ts'

// "Taking a while" thresholds. Below SLOW_MS the elapsed counter sits in
// muted ink; between SLOW_MS and STUCK_MS it darkens; past STUCK_MS we
// add a short hint that the user can Stop and retry.
const SLOW_MS = 15_000
const STUCK_MS = 60_000

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  return r === 0 ? `${m}m` : `${m}m${r}s`
}

export function StatusBar({ text, attachStatus }: { text: string; attachStatus: string }) {
  const t = useI18n((s) => s.t)
  const error = useAiStore((s) => s.error)
  const streaming = useAiStore((s) => s.streaming)
  const contextUsage = useAiStore((s) => s.contextUsage)

  // Streaming-elapsed timer. Reset on every streaming-rising edge so a
  // new turn starts at 0s. The 1s tick only runs while streaming, so an
  // idle composer doesn't pay re-renders for nothing.
  const [elapsedMs, setElapsedMs] = useState(0)
  useEffect(() => {
    if (!streaming) {
      setElapsedMs(0)
      return
    }
    const startedAt = Date.now()
    setElapsedMs(0)
    const id = setInterval(() => setElapsedMs(Date.now() - startedAt), 1000)
    return () => clearInterval(id)
  }, [streaming])
  // Tail-of-nodes derivations split into atomic selectors so the
  // status bar only re-renders when one of these primitives actually
  // changes — not on every 20-40Hz streaming chunk. A single object-
  // returning selector would yield a fresh reference per chunk and
  // force a re-render even when the displayed message is identical.
  const runningToolLabel = useChatStore((s) => {
    if (!streaming) return null
    for (let i = s.nodes.length - 1; i >= 0; i--) {
      const n = s.nodes[i]
      if (n.kind === 'tool' && n.running) return summarizeToolLabel(n.toolName, n.args)
    }
    return null
  })
  const generating = useChatStore((s) => {
    if (!streaming) return false
    const last = s.nodes[s.nodes.length - 1]
    return !!last && last.kind === 'assistant' && last.streaming && last.text.length > 0
  })

  // Status priority: error > attaching > live-agent-status > typing-counter > idle context-usage.
  // The typing counter shadows context-usage because it's the more
  // immediate feedback once the user starts writing.
  const message = (() => {
    if (error) return error
    if (attachStatus) return attachStatus
    if (streaming) {
      const base = runningToolLabel
        ? t('chat.status.runningTool', { tool: runningToolLabel })
        : generating
          ? t('chat.status.generating')
          : t('chat.status.thinking')
      // Show elapsed once at least one full second has rolled over so
      // the very first tick doesn't flash a confusing "0s". `Math.floor`
      // here matches the formatter, so the gate trips on the same tick
      // the first non-zero label would render.
      const elapsedSec = Math.floor(elapsedMs / 1000)
      if (elapsedSec < 1) return base
      const elapsed = ` ${formatElapsed(elapsedMs)}`
      if (elapsedMs >= STUCK_MS) return `${base}${elapsed} · ${t('chat.status.slowHint')}`
      return `${base}${elapsed}`
    }
    if (text.length > 0) {
      // 4 chars/token is the canonical English approximation; CJK is
      // closer to 1 char/token. Split the difference and stay coarse —
      // exact token count is the model's job at runtime.
      const approxTokens = Math.ceil(text.length / 4)
      return `${formatNumber(text.length)} chars · ~${formatTokens(approxTokens)} tokens`
    }
    if (contextUsage) {
      const { tokens, contextWindow } = contextUsage
      const pct = contextWindow > 0 ? Math.round((tokens / contextWindow) * 100) : 0
      return `${formatTokens(tokens)} / ${formatTokens(contextWindow)} (${pct}%)`
    }
    return ''
  })()

  // Slowness escalates the text color: SLOW_MS → ink-2 (slightly stronger),
  // STUCK_MS → warning. Errors and context-usage warnings still take priority.
  const slowKind: 'slow' | 'stuck' | undefined =
    streaming && elapsedMs >= STUCK_MS ? 'stuck' : streaming && elapsedMs >= SLOW_MS ? 'slow' : undefined
  const kind: 'err' | 'warn' | 'stuck' | 'slow' | undefined = error
    ? 'err'
    : contextUsage?.warn
      ? 'warn'
      : slowKind

  return (
    <span
      className={cn(
        'min-w-0 flex-1 truncate text-[11px] text-ink-3',
        kind === 'err' && 'text-danger',
        (kind === 'warn' || kind === 'stuck') && 'text-warning',
        kind === 'slow' && 'text-ink-2',
      )}
    >
      {message}
    </span>
  )
}

// Build the short tool label for the status line — `toolName(arg)` if
// args carry a path/name, otherwise just the tool name. Mirrors
// ChatList's chip-summary heuristic but trims aggressively so the
// one-line status doesn't wrap.
function summarizeToolLabel(toolName: string, args: unknown): string {
  if (!args || typeof args !== 'object') return toolName
  const a = args as Record<string, unknown>
  const candidate =
    typeof a.path === 'string'
      ? a.path
      : typeof a.name === 'string'
        ? a.name
        : ''
  if (!candidate) return toolName
  const trimmed = candidate.length > 32 ? '…' + candidate.slice(-31) : candidate
  return `${toolName}(${trimmed})`
}
