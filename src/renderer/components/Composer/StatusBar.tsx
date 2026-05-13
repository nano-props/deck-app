import { useEffect, useState } from 'react'
import { useAiStore } from '#/renderer/stores/ai.ts'
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
  // Status priority: error > attaching > streaming-elapsed > typing-counter > idle context-usage.
  // The typing counter shadows context-usage because it's the more
  // immediate feedback once the user starts writing.
  //
  // The "Thinking…" / "Generating…" / "Running tool: X" labels used to
  // live here next to the Send button. They moved to a `[…]` chat
  // bubble at the tail of ChatList — it reads as a chat affordance
  // ("the model is replying"), where this bar reads as a UI affordance
  // ("the form is busy"). What's left here in streaming state: just the
  // elapsed time, plus a slow-turn hint past STUCK_MS.
  const message = (() => {
    if (error) return error
    if (attachStatus) return attachStatus
    if (streaming) {
      // Hold off the elapsed counter for the first second so the bar
      // doesn't flash a confusing "0s" between agent_start and the
      // first tick.
      const elapsedSec = Math.floor(elapsedMs / 1000)
      if (elapsedSec < 1) return ''
      const elapsed = formatElapsed(elapsedMs)
      if (elapsedMs >= STUCK_MS) return `${elapsed} · ${t('chat.status.slowHint')}`
      return elapsed
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

