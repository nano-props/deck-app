// Chat history popover. Wraps Radix Popover so trigger/anchor/outside-
// click/Esc all come for free. We force `side="top"` so the panel
// always opens upward — the composer is at the bottom of the chat-pane
// and opening downward gets covered.

import { useEffect, useState, type ReactNode } from 'react'
import * as RP from '@radix-ui/react-popover'
import * as RT from '@radix-ui/react-tooltip'
import { X } from 'lucide-react'
import { formatDistanceToNowStrict, type Locale } from 'date-fns'
import { enUS, zhCN, ko } from 'date-fns/locale'
import { useAiStore } from '#/renderer/stores/ai.ts'
import { useI18n } from '#/renderer/stores/i18n.ts'
import type { Lang } from '#/main/i18n/index.ts'
import { cn } from '#/renderer/lib/cn.ts'
import { POPOVER_SURFACE } from '#/renderer/components/ui/popover-surface.ts'

const LOCALES: Record<Lang, Locale> = { en: enUS, zh: zhCN, ko }

import type { ProviderId } from '#/main/secrets.ts'
import { BUILTIN_LABELS, CUSTOM_LABEL_KEY } from '#/renderer/components/SettingsOverlay/providers.ts'

interface ChatSummary {
  id: string
  provider: ProviderId
  summary: string
  createdMs: number
  lastUsedMs: number
}

export function ChatHistoryPopover({
  trigger,
  tooltipContent,
  disabled,
}: {
  /** The bare button element used to open the popover. Must be a single
   *  DOM-rendering element — see the comment above `<RP.Trigger>` below
   *  for why nesting another `asChild` component (e.g. our `<Tooltip>`)
   *  in here breaks the click. */
  trigger: ReactNode
  /** Optional hover-tooltip text. We mount Tooltip here (rather than in
   *  the caller) so we can stack `Tooltip.Trigger asChild` and
   *  `Popover.Trigger asChild` directly on the same DOM button —
   *  Radix Slot only forwards props one level, so the two Triggers must
   *  be the immediate parents of the IconButton, not separated by
   *  another function component. */
  tooltipContent?: ReactNode
  /** When true the popover never opens (clicks are no-ops). Use this to
   *  match a disabled trigger button: passing `disabled` to the
   *  IconButton inside `trigger` blocks the click anyway, but Radix
   *  controls open-state through `onOpenChange` which the IconButton's
   *  disabled native attribute does not gate by itself. */
  disabled?: boolean
}) {
  const t = useI18n((s) => s.t)
  const [open, setOpen] = useState(false)
  const [sessions, setSessions] = useState<ChatSummary[] | null>(null) // null = loading
  const [activeId, setActiveId] = useState<string | null>(null)

  // Re-fetch each time the popover opens. Stale data on reopen is the
  // worst UX here (deleted item still showing) — refetching is cheap.
  // The same call seeds activePath; the user could have switched, sent,
  // or hit New Chat through other paths since the popover last opened,
  // so always trust main's answer instead of caching across opens.
  useEffect(() => {
    if (!open) return
    let aborted = false
    setSessions(null)
    void window.deck.chats
      .list()
      .then((res) => {
        if (aborted) return
        const list = res?.sessions
        setSessions(Array.isArray(list) ? list : [])
        setActiveId(res?.activeId ?? null)
      })
      .catch(() => {
        if (!aborted) {
          setSessions([])
          setActiveId(null)
        }
      })
    return () => {
      aborted = true
    }
  }, [open])

  // Stack the two `asChild` Triggers directly around the user-supplied
  // button so Radix Slot forwards BOTH sets of props (popover open +
  // tooltip hover) to the same DOM element. Note the ordering: the
  // tooltip Root must wrap the popover Root, but the two `Trigger`
  // elements must be adjacent (no function component between them) —
  // Radix Slot only walks one level when cloning, so any intermediate
  // function component (a non-Slot wrapper) silently swallows the
  // injected handlers.
  return (
    <RT.Root>
      <RP.Root open={open && !disabled} onOpenChange={(v) => !disabled && setOpen(v)}>
        <RT.Trigger asChild>
          <RP.Trigger asChild>{trigger}</RP.Trigger>
        </RT.Trigger>
        {tooltipContent && (
          <RT.Portal>
            <RT.Content
              side="top"
              sideOffset={6}
              className={cn(
                'z-[1000] max-w-[260px] rounded-md px-2 py-1.5 text-[11px] leading-snug',
                'bg-ink text-bg shadow-card',
                'dark:bg-[#2a2c30] dark:text-[#f2f3f5]',
                'data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95',
                'pointer-events-none select-none',
              )}
            >
              {tooltipContent}
            </RT.Content>
          </RT.Portal>
        )}
        <RP.Portal>
        <RP.Content
          side="top"
          align="start"
          sideOffset={6}
          className={cn(
            POPOVER_SURFACE,
            'flex max-h-[60vh] min-w-[280px] max-w-[420px] flex-col rounded-xl',
            'data-[state=open]:slide-in-from-bottom-1',
          )}
        >
          {sessions === null && <div className="px-4 py-6 text-center text-[12px] text-ink-4" />}
          {sessions !== null && sessions.length === 0 && (
            <div className="px-4 py-6 text-center text-[12px] text-ink-4">{t('composer.history.empty')}</div>
          )}
          {sessions !== null && sessions.length > 0 && (
            <div className="flex-1 overflow-y-auto p-1">
              {sessions.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  active={s.id === activeId}
                  onSwitch={async () => {
                    if (s.id === activeId) {
                      setOpen(false)
                      return
                    }
                    setActiveId(s.id)
                    setOpen(false)
                    await window.deck.chats.switch(s.id).catch(() => {})
                  }}
                  onDelete={async () => {
                    // Update state only if delete actually succeeded —
                    // otherwise we'd hide the chip while the file
                    // remains, and reopening the popover (which refetches)
                    // would resurrect it, looking like the delete bounced.
                    let ok = false
                    try {
                      const r = await window.deck.chats.delete(s.id)
                      ok = !!r?.ok
                    } catch {
                      ok = false
                    }
                    if (!ok) return
                    if (s.id === activeId) setActiveId(null)
                    setSessions((prev) => {
                      const next = prev ? prev.filter((x) => x.id !== s.id) : prev
                      // If we just deleted the last row, surface that to
                      // the composer so its History button greys out.
                      if (next && next.length === 0) {
                        useAiStore.getState().setHasHistory(false)
                      }
                      return next
                    })
                  }}
                />
              ))}
            </div>
          )}
        </RP.Content>
      </RP.Portal>
      </RP.Root>
    </RT.Root>
  )
}

function SessionRow({
  session,
  active,
  onSwitch,
  onDelete,
}: {
  session: ChatSummary
  active: boolean
  onSwitch: () => void
  onDelete: () => void
}) {
  const t = useI18n((s) => s.t)
  const lang = useI18n((s) => s.lang)
  // Outer is a div + role=menuitem (NOT button) so the inner Delete
  // button isn't nested inside another interactive element. Enter/Space
  // on the row triggers switch; the X has its own button + aria-label.
  return (
    <div
      role="menuitem"
      tabIndex={0}
      aria-current={active ? 'true' : undefined}
      onClick={onSwitch}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSwitch()
        }
      }}
      className={cn(
        'group relative grid w-full grid-cols-[3px_1fr_auto] items-center gap-2 rounded-md px-2.5 py-2 text-left',
        'cursor-pointer transition-colors hover:bg-line focus-visible:bg-line focus-visible:outline-none',
      )}
    >
      <span className={cn('h-8 w-[3px] rounded-sm', active ? 'bg-accent' : 'bg-transparent')} aria-hidden="true" />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="line-clamp-2 overflow-hidden text-ellipsis text-[13px] leading-snug text-ink">
          {session.summary || ''}
        </span>
        <span className="flex items-center gap-2 text-[11px] text-ink-4">
          <ProviderChip provider={session.provider} />
          <span>{relativeTime(session.lastUsedMs, lang)}</span>
        </span>
      </span>
      <button
        type="button"
        aria-label={t('composer.history.delete.aria')}
        className="inline-flex size-6 items-center justify-center rounded text-ink-4 opacity-0 transition-opacity hover:bg-line hover:text-danger group-hover:opacity-100 focus-visible:opacity-100"
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}

// `formatDistanceToNowStrict` produces "5 minutes" / "2 hours" / "3 days"
// in the active locale. We append "ago" via `addSuffix: true`, which the
// locale's own translation handles ("5 minutes ago" / "5 分钟前" / "5분 전").
function relativeTime(ms: number, lang: Lang): string {
  return formatDistanceToNowStrict(ms, { addSuffix: true, locale: LOCALES[lang] })
}

/** Tiny provider tag shown on each session row. Provider lock is a
 *  fundamental property of a deck session in Phase 1 — surfacing it
 *  here helps the user understand "this old conversation is in
 *  Anthropic; switching back to it temporarily uses Anthropic even
 *  though my default is now Claude Code". */
function ProviderChip({ provider }: { provider: ProviderId }) {
  const t = useI18n((s) => s.t)
  const customKey = CUSTOM_LABEL_KEY[provider]
  // Fallback to the raw provider id when neither label table knows
  // about it — handles forward-compat (a record written by a newer
  // version) and corrupted on-disk metadata gracefully.
  const label = BUILTIN_LABELS[provider] ?? (customKey ? t(customKey as never) : provider)
  return (
    <span className="rounded border border-line bg-bg-deep px-1.5 py-0.5 text-[10px] font-medium text-ink-3">
      {label}
    </span>
  )
}
