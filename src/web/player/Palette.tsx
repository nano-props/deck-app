// Command palette: a focused overlay that exposes the player's
// container-level actions (back, switch deck). Triggered by Cmd/Ctrl+K
// or "?", closed by Esc / outside click.
//
// Built on Radix Dialog so focus trap, scroll lock, and outside-click
// dismissal come for free. The internal arrow-key navigation /
// `.active` highlight is hand-rolled because Radix doesn't ship a
// command-list primitive — and we want exact parity with the vanilla
// version's keyboard model (Home/End, Tab cycling, mousemove sync).

import * as Dialog from '@radix-ui/react-dialog'
import { ArrowLeft, Layers } from 'lucide-react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { useI18n, asHtml } from '#/web/lib/i18n.ts'
import { listRecents, type RecentItem } from './cache.ts'
import { formatRelative } from '#/web/lib/time-format.ts'

export interface PaletteItem {
  key: string
  icon: ReactNode
  label: string
  meta: string
  activate: () => void
}

interface PaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onBack: () => void
  onOpenDeck: (deckId: string) => void
}

export function Palette({ open, onOpenChange, onBack, onOpenDeck }: PaletteProps) {
  const t = useI18n((s) => s.t)
  const [recents, setRecents] = useState<RecentItem[]>([])
  // openGen guards against the recents fetch resolving after the user
  // has closed (and possibly re-opened) the palette — without this,
  // a stale snapshot could land in a fresh session.
  const openGen = useRef(0)

  useEffect(() => {
    if (!open) return
    const gen = ++openGen.current
    setRecents([])
    listRecents()
      .then((items) => {
        if (gen !== openGen.current) return
        setRecents(items)
      })
      .catch((err) => console.error(err))
  }, [open])

  // Build items in render: actions first (always), then recents
  // (streamed in once async fetch resolves). Item identity drives
  // keyboard navigation indices below.
  const items = useMemo<PaletteItem[]>(() => {
    const out: PaletteItem[] = [
      {
        key: 'back',
        icon: <ArrowLeft size={18} aria-hidden />,
        label: t('paletteBack'),
        meta: 'Esc',
        activate: () => {
          onOpenChange(false)
          onBack()
        },
      },
    ]
    for (const r of recents) {
      out.push({
        key: 'deck-' + r.id,
        icon: <Layers size={18} aria-hidden />,
        label: r.name,
        meta: formatRelative(r.ts),
        activate: () => {
          onOpenChange(false)
          onOpenDeck(r.id)
        },
      })
    }
    return out
  }, [recents, t, onOpenChange, onBack, onOpenDeck])

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[100] bg-[rgb(15_17_21_/_0.35)] backdrop-blur-[2px]" />
        <Dialog.Content
          aria-label={t('paletteTitle')}
          // Anchor near the top, not center — same as vanilla. 12vh
          // pushes the panel below most browser UI without floating
          // mid-screen.
          className="fixed inset-x-0 top-[max(12vh,80px)] z-[100] mx-auto w-[min(560px,calc(100vw-32px))] max-h-[70vh] overflow-hidden bg-surface border border-line rounded-xl shadow-card flex flex-col animate-in fade-in-0 zoom-in-95 slide-in-from-top-1"
        >
          <PaletteHeader title={t('paletteTitle')} hint={t('paletteEsc')} />
          <PaletteBody
            items={items}
            recentsHasGroup={recents.length > 0}
            switchLabel={t('paletteSwitch')}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function PaletteHeader({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-line text-[12px] font-semibold uppercase tracking-[0.04em] text-mute">
      <Dialog.Title asChild>
        <span>{title}</span>
      </Dialog.Title>
      <span
        className="font-normal normal-case tracking-normal"
        dangerouslySetInnerHTML={asHtml(hint)}
      />
    </div>
  )
}

function PaletteBody({
  items,
  recentsHasGroup,
  switchLabel,
}: {
  items: PaletteItem[]
  recentsHasGroup: boolean
  switchLabel: string
}) {
  const [active, setActive] = useState(0)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])

  // Reset highlight when the item set changes (recents stream in).
  useEffect(() => {
    setActive((prev) => (prev >= items.length ? 0 : prev))
  }, [items])

  // Scroll the active row into view as the user navigates with the
  // keyboard. Pointer-only navigation (mousemove / click) updates
  // `active` too, but doesn't need scrolling.
  useEffect(() => {
    const el = itemRefs.current[active]
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' })
    }
  }, [active])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (items.length === 0) return
    const len = items.length
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (i + 1) % len)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (i - 1 + len) % len)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActive(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setActive(len - 1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      items[active]?.activate()
    } else if (e.key === 'Tab') {
      // Focus trap: keep Tab inside the palette so the user can't tab
      // to elements behind the modal overlay (and into the iframe,
      // where keys would no longer reach this listener).
      e.preventDefault()
      setActive((i) => {
        const next = e.shiftKey ? i - 1 : i + 1
        return ((next % len) + len) % len
      })
    }
  }

  // Group rendering. Vanilla added a `.group` divider with an optional
  // group-label. Actions (the always-on group) gets no label; recents
  // gets `paletteSwitch` (e.g. "Switch deck").
  const actions = items.filter((i) => i.key === 'back')
  const recents = items.filter((i) => i.key !== 'back')

  return (
    <div
      // Outer wrapper takes focus so arrow keys are received here, not
      // by the iframe behind the overlay (Radix Content gets focus on
      // open by default). tabIndex=-1 so we can focus programmatically
      // without putting it in the tab order.
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="overflow-y-auto p-1.5 outline-none"
    >
      <Group>
        {actions.map((item, i) => (
          <Item
            key={item.key}
            item={item}
            ref={(el) => {
              itemRefs.current[i] = el
            }}
            active={active === i}
            onActivate={() => setActive(i)}
          />
        ))}
      </Group>
      {recentsHasGroup && (
        <Group label={switchLabel}>
          {recents.map((item, ri) => {
            const idx = ri + actions.length
            return (
              <Item
                key={item.key}
                item={item}
                ref={(el) => {
                  itemRefs.current[idx] = el
                }}
                active={active === idx}
                onActivate={() => setActive(idx)}
              />
            )
          })}
        </Group>
      )}
    </div>
  )
}

function Group({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="[&_+_&]:border-t [&_+_&]:border-line [&_+_&]:mt-1.5 [&_+_&]:pt-1.5">
      {label && (
        <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-semibold uppercase tracking-[0.04em] text-mute">
          {label}
        </div>
      )}
      {children}
    </div>
  )
}

interface ItemProps {
  item: PaletteItem
  active: boolean
  onActivate: () => void
  ref?: React.Ref<HTMLButtonElement>
}

function Item({ item, active, onActivate, ref }: ItemProps) {
  return (
    <button
      ref={ref}
      type="button"
      role="option"
      aria-selected={active}
      onClick={item.activate}
      // mousemove syncs the keyboard cursor to the pointer — keeps the
      // user's typing experience consistent if they grab the mouse
      // mid-navigation. Skipped when this row is already active so we
      // don't re-render every frame the cursor moves over it.
      onMouseMove={() => {
        if (!active) onActivate()
      }}
      className={
        'flex items-center gap-2.5 w-full px-3 py-2.5 m-0 bg-transparent border-0 rounded-lg font-[inherit] text-[inherit] text-left cursor-pointer transition-colors duration-[120ms] hover:bg-[rgb(var(--color-accent-rgb)_/_0.08)] focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2 ' +
        (active ? 'bg-[rgb(var(--color-accent-rgb)_/_0.08)]' : '')
      }
    >
      <span
        className={
          'shrink-0 w-5 h-5 flex items-center justify-center transition-colors duration-[120ms] ' +
          (active ? 'text-accent' : 'text-mute')
        }
      >
        {item.icon}
      </span>
      <span className="flex-1 min-w-0 whitespace-nowrap overflow-hidden text-ellipsis">
        {item.label}
      </span>
      <span className="shrink-0 text-xs text-mute">{item.meta}</span>
    </button>
  )
}
