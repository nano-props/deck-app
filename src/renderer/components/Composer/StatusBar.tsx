import { useAiStore } from '#/renderer/stores/ai.ts'
import { useI18n } from '#/renderer/stores/i18n.ts'
import { cn } from '#/renderer/lib/cn.ts'
import { formatNumber, formatTokens } from '#/renderer/components/Composer/format.ts'

export function StatusBar({ text, attachStatus }: { text: string; attachStatus: string }) {
  const t = useI18n((s) => s.t)
  const error = useAiStore((s) => s.error)
  const streaming = useAiStore((s) => s.streaming)
  const contextUsage = useAiStore((s) => s.contextUsage)

  // Status priority: error > attaching > thinking > typing-counter > idle context-usage.
  // The typing counter shadows context-usage because it's the more
  // immediate feedback once the user starts writing.
  const message = (() => {
    if (error) return error
    if (attachStatus) return attachStatus
    if (streaming) return t('chat.status.thinking')
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

  const kind: 'err' | 'warn' | undefined = error ? 'err' : contextUsage?.warn ? 'warn' : undefined

  return (
    <span
      className={cn(
        'min-w-0 flex-1 truncate text-[11px] text-ink-3',
        kind === 'err' && 'text-danger',
        kind === 'warn' && 'text-warning',
      )}
    >
      {message}
    </span>
  )
}
