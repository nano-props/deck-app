// "Recently opened" list on the upload screen. Reads via listRecents();
// re-fetches on the player's recentsTick. Mutations (open, delete) are
// delegated to the parent so it can sequence them against in-flight
// loads, history state, and the undo toast.

import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { useI18n } from '#/web/lib/i18n.ts'
import { listRecents, type RecentItem } from './cache.ts'
import { formatRelative } from '#/web/lib/time-format.ts'
import { usePlayer } from './state.ts'

interface RecentsListProps {
  onOpen: (deckId: string) => void
  onDelete: (deckId: string, name: string) => void
}

export function RecentsList({ onOpen, onDelete }: RecentsListProps) {
  const t = useI18n((s) => s.t)
  const tick = usePlayer((s) => s.recentsTick)
  const [items, setItems] = useState<RecentItem[]>([])

  useEffect(() => {
    let cancelled = false
    listRecents()
      .then((next) => {
        if (!cancelled) setItems(next)
      })
      .catch((err) => console.error(err))
    return () => {
      cancelled = true
    }
  }, [tick])

  if (items.length === 0) return null

  return (
    <div className="w-full mt-10 text-left">
      <h2 className="m-0 mb-2 text-[12px] font-semibold uppercase tracking-[0.04em] text-mute">
        {t('playerRecents')}
      </h2>
      <ul className="list-none m-0 p-0">
        {items.map((item) => (
          <Row key={item.id} item={item} onOpen={onOpen} onDelete={onDelete} />
        ))}
      </ul>
    </div>
  )
}

function Row({
  item,
  onOpen,
  onDelete,
}: {
  item: RecentItem
  onOpen: (id: string) => void
  onDelete: (id: string, name: string) => void
}) {
  return (
    // The vanilla styles are quite distinctive (hover lift, fade-in
    // delete button, focus-within border). Re-encoded as Tailwind
    // utilities with a `group` so children can react to row hover.
    // @media (hover: none) keeps the delete button visible on touch
    // devices — encoded via the arbitrary `[@media(hover:none)]`
    // variant.
    <li className="group relative rounded-lg border border-transparent transition-[background,border-color,translate,box-shadow] duration-200 hover:bg-surface hover:border-line-2 hover:-translate-y-px hover:shadow-card focus-within:bg-surface focus-within:border-accent mt-1 first:mt-0">
      <button
        type="button"
        title={`Open ${item.name}`}
        onClick={() => onOpen(item.id)}
        className="flex flex-col w-full pl-3 pr-12 py-2.5 bg-transparent border-0 m-0 rounded-[inherit] font-[inherit] text-[inherit] text-left cursor-pointer focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-[3px]"
      >
        <span className="max-w-full min-w-0 whitespace-nowrap overflow-hidden text-ellipsis font-medium transition-colors duration-200 group-hover:text-accent">
          {item.name}
        </span>
        <span className="text-[13px] text-mute mt-0.5">
          {formatRelative(item.ts)}
        </span>
      </button>
      {/*
        Centering uses CSS-native `translate` (Tailwind v4's `-translate-y-1/2`
        emits `translate: 0 -50%`, NOT a `transform` declaration). Hover
        scale uses `scale-*` for the same reason — writing `transform` by
        hand here would NOT override the `translate` property; it would
        compose on top, double-shifting the button half its height up
        and out of the row.
      */}
      <button
        type="button"
        aria-label={`Remove ${item.name}`}
        title="Remove from cache"
        onClick={(e) => {
          e.stopPropagation()
          onDelete(item.id, item.name)
        }}
        className="absolute top-1/2 right-2 -translate-y-1/2 w-8 h-8 p-0 bg-transparent border-0 rounded-md text-mute cursor-pointer flex items-center justify-center z-[1] opacity-0 transition-[opacity,background,color,scale] duration-200 group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-[rgb(220_38_38_/_0.1)] hover:text-[#dc2626] hover:scale-[1.08] focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-[3px] [@media(hover:none)]:opacity-100"
      >
        <Trash2 size={14} aria-hidden />
      </button>
    </li>
  )
}
