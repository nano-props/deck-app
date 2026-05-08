// Self-drawn application menu (Win/Linux only).
//
// macOS uses the OS menu bar; the topbar trigger is hidden via CSS
// (html[data-chrome='overlay']). On other platforms, clicking the
// hamburger trigger opens this panel — File / Edit / View as tabs,
// items dispatched through window.deck.menu.invoke.
//
// Tree comes from main, re-pushed on focus / state change.

import { useEffect, useRef, useState } from 'react'
import * as RP from '@radix-ui/react-popover'
import type { MenuActionId, MenuNode } from '#/main/menu/index.ts'
import { cn } from '#/renderer/lib/cn.ts'

const IS_MAC = /Mac/i.test(navigator.platform)

export function AppMenu() {
  const [tree, setTree] = useState<MenuNode[]>([])
  const [open, setOpen] = useState(false)
  const [selectedIdx, setSelectedIdx] = useState(0)

  useEffect(() => {
    if (IS_MAC) return
    void window.deck.menu.get().then((t) => setTree(Array.isArray(t) ? t : []))
    const off = window.deck.menu.onChange((next) => setTree(Array.isArray(next) ? next : []))
    return off
  }, [])

  // Anchor the panel to the topbar's #appMenuTrigger button (rendered by
  // Topbar). We use Radix's Anchor so the button itself doesn't need to
  // be controlled.
  const anchorRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (IS_MAC) return
    const el = document.getElementById('appMenuTrigger') as HTMLButtonElement | null
    anchorRef.current = el
    if (!el) return
    const onClick = () => {
      setOpen((v) => !v)
      setSelectedIdx(0)
    }
    el.addEventListener('click', onClick)
    return () => el.removeEventListener('click', onClick)
  }, [])

  if (IS_MAC) return null

  const submenus = tree.filter((n): n is Extract<MenuNode, { kind: 'submenu' }> => n.kind === 'submenu')
  const selected = submenus[selectedIdx]

  // Keyboard navigation:
  //   ← / →   move between top-level submenu tabs (wraps)
  //   ↑ / ↓   move focus through enabled items in the active tab (wraps)
  //   Enter / Space on a focused item: native button click — no extra wiring.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (submenus.length === 0) return
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      const dir = e.key === 'ArrowLeft' ? -1 : 1
      setSelectedIdx((i) => (i + dir + submenus.length) % submenus.length)
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const root = e.currentTarget
      const items = Array.from(
        root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])'),
      )
      if (items.length === 0) return
      const dir = e.key === 'ArrowDown' ? 1 : -1
      const active = document.activeElement as HTMLElement | null
      const cur = active ? items.indexOf(active as HTMLButtonElement) : -1
      const next = (cur + dir + items.length) % items.length
      items[next].focus()
    }
  }

  return (
    <RP.Root open={open} onOpenChange={setOpen}>
      <RP.Anchor virtualRef={{ current: anchorRef.current ?? document.body }} />
      <RP.Portal>
        <RP.Content
          side="bottom"
          align="start"
          sideOffset={4}
          className={cn(
            'z-[100] min-w-[260px] max-w-[360px] overflow-hidden rounded-lg border border-line-2 bg-surface text-[13px] text-ink shadow-card-lift',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0',
            '[-webkit-app-region:no-drag]',
          )}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onKeyDown={onKeyDown}
        >
          {/* Tabs */}
          <div className="flex gap-0.5 border-b border-line bg-bg-deep p-1">
            {submenus.map((sub, i) => (
              <button
                key={sub.id ?? sub.label}
                type="button"
                className={cn(
                  'rounded px-2.5 py-1 text-[12px] font-medium transition-colors',
                  i === selectedIdx ? 'bg-surface text-ink shadow-[0_0_0_1px_var(--color-line-2)]' : 'text-ink-2 hover:bg-line hover:text-ink',
                )}
                onMouseEnter={() => setSelectedIdx(i)}
                onClick={() => setSelectedIdx(i)}
              >
                {sub.label}
              </button>
            ))}
          </div>

          {/* Items */}
          {selected && (
            <div className="max-h-[70vh] overflow-y-auto p-1">
              {selected.items.map((item, i) => {
                if (item.kind === 'separator') {
                  return <div key={`sep-${i}`} role="separator" className="mx-1.5 my-1 h-px bg-line" />
                }
                if (item.kind === 'submenu') {
                  return (
                    <div key={`heading-${i}`} className="px-2.5 py-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-4">
                      {item.label}
                    </div>
                  )
                }
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitem"
                    disabled={!item.enabled}
                    onClick={() => {
                      setOpen(false)
                      void window.deck.menu.invoke(item.id as MenuActionId)
                    }}
                    className={cn(
                      'flex w-full items-center justify-between gap-6 rounded px-2.5 py-1.5 text-left text-[13px] text-ink',
                      'transition-colors hover:bg-line focus-visible:bg-line focus-visible:outline-none',
                      'disabled:cursor-not-allowed disabled:text-ink-4 disabled:hover:bg-transparent',
                    )}
                  >
                    <span className="flex-1 truncate">{item.label}</span>
                    {item.accelerator && (
                      <span className="text-[11px] font-mono tracking-wide text-ink-4">{formatAccelerator(item.accelerator)}</span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </RP.Content>
      </RP.Portal>
    </RP.Root>
  )
}

function formatAccelerator(acc: string): string {
  return acc
    .split('+')
    .map((part) => {
      const k = part.trim()
      if (k === 'CmdOrCtrl' || k === 'Cmd' || k === 'Command') return 'Ctrl'
      if (k === 'Plus') return '+'
      return k
    })
    .join('+')
}
