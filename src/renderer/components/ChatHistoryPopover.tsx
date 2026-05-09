// Chat history popover. Wraps Radix Popover so trigger/anchor/outside-
// click/Esc all come for free. We force `side="top"` so the panel
// always opens upward — the composer is at the bottom of the chat-pane
// and opening downward gets covered.

import { useEffect, useState, type ReactNode } from 'react'
import * as RP from '@radix-ui/react-popover'
import { X } from 'lucide-react'
import { formatDistanceToNowStrict, type Locale } from 'date-fns'
import { enUS, zhCN, ko } from 'date-fns/locale'
import { useI18n } from '#/renderer/stores/i18n.ts'
import type { Lang } from '#/main/i18n/index.ts'
import { cn } from '#/renderer/lib/cn.ts'
import { POPOVER_SURFACE } from '#/renderer/components/ui/popover-surface.ts'

const LOCALES: Record<Lang, Locale> = { en: enUS, zh: zhCN, ko }

interface ChatSummary {
  path: string
  firstMessage: string
  messageCount: number
  modifiedMs: number
}

export function ChatHistoryPopover({ trigger }: { trigger: ReactNode }) {
  const t = useI18n((s) => s.t)
  const [open, setOpen] = useState(false)
  const [sessions, setSessions] = useState<ChatSummary[] | null>(null) // null = loading
  const [activePath, setActivePath] = useState<string | null>(null)

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
        setActivePath(res?.activePath ?? null)
      })
      .catch(() => {
        if (!aborted) {
          setSessions([])
          setActivePath(null)
        }
      })
    return () => {
      aborted = true
    }
  }, [open])

  return (
    <RP.Root open={open} onOpenChange={setOpen}>
      <RP.Trigger asChild>{trigger}</RP.Trigger>
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
                  key={s.path}
                  session={s}
                  active={s.path === activePath}
                  onSwitch={async () => {
                    if (s.path === activePath) {
                      setOpen(false)
                      return
                    }
                    setActivePath(s.path)
                    setOpen(false)
                    await window.deck.chats.switch(s.path).catch(() => {})
                  }}
                  onDelete={async () => {
                    await window.deck.chats.delete(s.path).catch(() => {})
                    if (s.path === activePath) setActivePath(null)
                    setSessions((prev) => (prev ? prev.filter((x) => x.path !== s.path) : prev))
                  }}
                />
              ))}
            </div>
          )}
        </RP.Content>
      </RP.Portal>
    </RP.Root>
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
          {session.firstMessage || ''}
        </span>
        <span className="flex gap-2 text-[11px] text-ink-4">{relativeTime(session.modifiedMs, lang)}</span>
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
