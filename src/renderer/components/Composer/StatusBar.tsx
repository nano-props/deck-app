import { useAiStore } from '#/renderer/stores/ai.ts'
import { useChatStore } from '#/renderer/stores/chat.ts'
import { useI18n } from '#/renderer/stores/i18n.ts'
import { cn } from '#/renderer/lib/cn.ts'
import { formatNumber, formatTokens } from '#/renderer/components/Composer/format.ts'

export function StatusBar({ text, attachStatus }: { text: string; attachStatus: string }) {
  const t = useI18n((s) => s.t)
  const error = useAiStore((s) => s.error)
  const streaming = useAiStore((s) => s.streaming)
  const contextUsage = useAiStore((s) => s.contextUsage)
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
      if (runningToolLabel) return t('chat.status.runningTool', { tool: runningToolLabel })
      if (generating) return t('chat.status.generating')
      return t('chat.status.thinking')
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
