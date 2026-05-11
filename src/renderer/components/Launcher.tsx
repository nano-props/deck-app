// Launcher — two primary actions (New / Open file), a recents list, the
// decorative card stack, drag-to-open ring, and a loading overlay shown
// while main unpacks/extracts.
//
// Open-file accepts `.deck` packs and standalone `.html` files (the
// latter loads as a read-only quick preview). Folder-form Decks have
// no UI entry point; they reach the app only via drag-drop or CLI argv.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Plus, Folder, FileCode, X } from 'lucide-react'
import { useAppStore } from '#/renderer/stores/app.ts'
import { useI18n } from '#/renderer/stores/i18n.ts'
import { Button, IconButton } from '#/renderer/components/ui/Button.tsx'
import { cn } from '#/renderer/lib/cn.ts'

interface RecentEntry {
  path: string
  name: string
  openedAt: number
}

function shortenPath(p: string): string {
  const home = p.startsWith('/Users/') || p.startsWith('/home/') ? p.split('/').slice(0, 3).join('/') : null
  if (home && p.startsWith(home)) return '~' + p.slice(home.length)
  return p
}

export function Launcher() {
  const t = useI18n((s) => s.t)
  const loading = useAppStore((s) => s.loading)
  const [recents, setRecents] = useState<RecentEntry[]>([])
  const [dragOver, setDragOver] = useState(false)
  // Mirror of dragOver readable from the DragEvent listeners without
  // closing over a stale state value. The handlers use this to skip
  // the React dispatch entirely when the value isn't actually changing
  // (dragover fires ~60Hz; React would internally bail on equal
  // values, but skipping the dispatch is cheaper still).
  const dragOverRef = useRef(false)
  const setDrag = useCallback((v: boolean) => {
    if (dragOverRef.current === v) return
    dragOverRef.current = v
    setDragOver(v)
  }, [])

  const refreshRecents = useCallback(async () => {
    try {
      const r = await window.deck.listRecents()
      setRecents(Array.isArray(r) ? r : [])
    } catch {
      setRecents([])
    }
  }, [])

  // Refresh whenever the launcher mounts (which is exactly when the
  // user lands here — App.tsx unmounts other modes).
  useEffect(() => {
    void refreshRecents()
  }, [refreshRecents])

  // Window-level drag-drop. Uses native events so a drop anywhere on
  // the launcher routes to main (main does the deck-vs-not dispatch).
  useEffect(() => {
    // Filter on `Files` so dragging a non-file payload (selected text from
    // a browser, an in-page image without a backing file) doesn't flash
    // the drop ring on a drag we know we won't honor in onDrop. Mirrors
    // the Composer's useFileStaging.onDragOver gate.
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types?.includes('Files')) return
      e.preventDefault()
      setDrag(true)
    }
    const onDragLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDrag(false)
    }
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      setDrag(false)
      const files = e.dataTransfer?.files
      if (!files || files.length === 0) return
      for (const f of files) void window.deck.openDroppedFile(f)
    }
    window.addEventListener('dragenter', onDragOver)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragOver)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [setDrag])

  return (
    <section
      className={cn(
        'relative grid h-full',
        // The radial gradient highlights — pure decoration.
        "before:content-[''] before:absolute before:inset-0 before:pointer-events-none before:z-0",
        'before:[background:radial-gradient(ellipse_80%_60%_at_85%_20%,rgb(var(--color-accent-rgb)/0.06)_0%,transparent_55%),radial-gradient(ellipse_50%_50%_at_10%_100%,rgb(var(--color-ambient-rgb)/0.03)_0%,transparent_55%)]',
      )}
    >
      <main
        className={cn(
          'relative z-10 grid h-full items-center justify-center gap-16 overflow-y-auto px-16 py-10',
          'grid-cols-[minmax(0,560px)_360px]',
          'max-[1120px]:grid-cols-[minmax(0,1fr)_280px] max-[1120px]:gap-10 max-[1120px]:px-10 max-[1120px]:py-8',
          'max-[880px]:grid-cols-[1fr] max-[880px]:gap-0 max-[880px]:justify-items-center',
        )}
      >
        <div className="w-full max-w-[560px]">
          <h1 className="m-0 mb-3 text-[36px] font-bold tracking-tight">{t('launcher.title')}</h1>
          <p className="m-0 mb-6 text-[14px] text-ink-3">{t('launcher.lede')}</p>

          <div className="mb-8 flex flex-wrap items-center gap-2.5">
            <Button variant="primary" onClick={() => void window.deck.newDeck()} data-interactive>
              <Plus className="size-4" />
              <span>{t('launcher.newDeck')}</span>
            </Button>
            <Button onClick={() => void window.deck.openDialog()} data-interactive>
              <span>{t('launcher.openFile')}</span>
              <span className="kbd">⌘O</span>
            </Button>
          </div>

          {recents.length > 0 && (
            <section className="flex max-w-[560px] flex-col gap-2">
              <h2 className="m-0 text-[11px] font-semibold uppercase tracking-wider text-ink-4">
                {t('launcher.recent')}
              </h2>
              <ul className="m-0 flex list-none flex-col gap-0.5 p-0" data-interactive>
                {recents.map((r) => (
                  <RecentItem key={r.path} entry={r} onForget={refreshRecents} t={t} />
                ))}
              </ul>
            </section>
          )}
        </div>

        <Visual />
      </main>

      <div
        className={cn(
          'pointer-events-none absolute inset-3 z-30 rounded-2xl border-2 border-dashed border-transparent',
          'transition-colors duration-150',
          dragOver && 'border-[rgb(var(--color-accent-rgb)/0.55)] bg-[rgb(var(--color-accent-rgb)/0.04)]',
        )}
      />

      {loading && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-3 bg-[rgb(var(--color-bg-rgb)/0.7)] backdrop-blur-sm">
          <div className="size-7 rounded-full border-2 border-line-2 border-t-accent animate-spin" />
          <div className="text-[13px] text-ink">{t('launcher.loading')}</div>
        </div>
      )}
    </section>
  )
}

function RecentItem({
  entry,
  onForget,
  t,
}: {
  entry: RecentEntry
  onForget: () => void
  t: ReturnType<typeof useI18n.getState>['t']
}) {
  const lowered = entry.path.toLowerCase()
  const isPack = lowered.endsWith('.deck')
  const isHtml = lowered.endsWith('.html') || lowered.endsWith('.htm')
  const forgetLabel = t('launcher.forget')
  const open = () => void window.deck.openPath(entry.path)
  return (
    // role/tabIndex/keydown make the row keyboard-operable. Without them
    // the only way to open a recent was a mouse click — keyboard users
    // could only delete entries via the X button.
    <li
      role="button"
      tabIndex={0}
      aria-label={t('launcher.openRecentAria', { name: entry.name || entry.path })}
      className={cn(
        'group grid cursor-pointer grid-cols-[auto_1fr_auto_auto] items-center gap-2.5 rounded-md px-2.5 py-2',
        'transition-colors duration-100 hover:bg-line',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
      )}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          open()
        }
      }}
    >
      <span className="text-ink-4">
        {isPack ? <PackIcon /> : isHtml ? <FileCode className="size-3.5" /> : <Folder className="size-3.5" />}
      </span>
      <span className="truncate text-[13px] text-ink">{entry.name || t('launcher.unnamed')}</span>
      <span className="max-w-[240px] truncate font-mono text-[11px] text-ink-4">{shortenPath(entry.path)}</span>
      <IconButton
        size="sm"
        className="opacity-0 group-hover:opacity-100 transition-opacity duration-100 focus-visible:opacity-100"
        title={forgetLabel}
        aria-label={forgetLabel}
        onClick={async (e) => {
          e.stopPropagation()
          await window.deck.forgetRecent(entry.path)
          onForget()
        }}
        // Stop the row's keydown from interpreting Enter/Space on the X.
        onKeyDown={(e) => e.stopPropagation()}
      >
        <X />
      </IconButton>
    </li>
  )
}

function PackIcon() {
  return (
    <svg
      className="size-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  )
}

// ---- Decorative stack -------------------------------------------------------

function Visual() {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'visual relative aspect-[4/3] w-full max-w-[360px] self-center opacity-0',
        'animate-rise',
        'max-[880px]:hidden',
      )}
    >
      <Card variant="back" />
      <Card variant="middle" />
      <Card variant="front" />
      <span
        className={cn(
          'absolute -bottom-2 -left-2 rounded-md border border-line bg-surface px-2 py-1 text-[11px]',
          'font-mono text-ink-4 tracking-wider shadow-sm',
        )}
      >
        .deck
      </span>
    </div>
  )
}

function Card({ variant }: { variant: 'back' | 'middle' | 'front' }) {
  const placement = {
    back: 'inset-y-[24%] inset-x-[18%] -rotate-6 opacity-75',
    middle: 'inset-y-[16%] inset-x-[10%] rotate-3',
    front: 'inset-[8%] -rotate-1.5 border-line-2 shadow-card-lift',
  }[variant]
  return (
    <div className={cn('absolute rounded-2xl border border-line bg-surface shadow-card', placement)}>
      {variant === 'front' && (
        <span className="absolute right-4 top-4 size-1.5 rounded-full bg-accent shadow-[0_0_0_3px_rgb(var(--color-accent-rgb)/0.18)]" />
      )}
      <span className="absolute left-4 top-[18px] h-1.5 w-[55%] rounded bg-ink-4" />
      <span className="absolute left-4 top-[30px] h-1.5 w-[38%] rounded bg-ink-5" />
      <span className="absolute left-4 top-[42px] h-1.5 w-[46%] rounded bg-ink-5" />
    </div>
  )
}
