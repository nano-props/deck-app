// Editor mode — left chat-pane (chat list + composer) | divider |
// right preview-pane.
//
// `--chat-width` is persisted in localStorage and clamped to the editor
// pane's actual width. Divider drag updates the CSS var; everything
// else is grid-driven.

import { useEffect, useRef, useState } from 'react'
import { useDeckPreviewBounds } from '#/renderer/hooks/useDeckPreviewBounds.ts'
import { ChatList } from '#/renderer/components/ChatList.tsx'
import { Composer } from '#/renderer/components/Composer/index.tsx'
import { cn } from '#/renderer/lib/cn.ts'

const LS_KEY = 'deck:chat-width'
const MIN_CHAT = 280
const MIN_PREVIEW = 320
const DIVIDER = 1

function readSavedWidth(): number {
  const n = Number(localStorage.getItem(LS_KEY))
  return Number.isFinite(n) && n > 0 ? n : 532
}

export function Editor() {
  const mainRef = useRef<HTMLDivElement>(null)
  const previewRef = useDeckPreviewBounds()
  const [chatWidth, setChatWidth] = useState<number>(readSavedWidth)
  const [dragging, setDragging] = useState(false)

  // Clamp on every relevant change (mount, window resize, drag). The
  // editor-main width is the source of truth; we never let chat go past
  // total - MIN_PREVIEW - DIVIDER.
  useEffect(() => {
    const onResize = () => {
      const total = mainRef.current?.getBoundingClientRect().width ?? 0
      if (total === 0) return
      const max = Math.max(MIN_CHAT, total - MIN_PREVIEW - DIVIDER)
      setChatWidth((w) => Math.max(MIN_CHAT, Math.min(max, w)))
    }
    window.addEventListener('resize', onResize)
    onResize()
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Persist with a 250ms idle debounce. localStorage.setItem is
  // synchronous IO; writing it 60×/s during a pointer drag costs real
  // frames. Idle-trailing means the final width survives, but the
  // intermediate values during a drag don't hit disk.
  useEffect(() => {
    const timer = setTimeout(() => {
      localStorage.setItem(LS_KEY, String(Math.round(chatWidth)))
    }, 250)
    return () => clearTimeout(timer)
  }, [chatWidth])

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    setDragging(true)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging) return
    const total = mainRef.current?.getBoundingClientRect()
    if (!total) return
    const next = e.clientX - total.left
    const max = Math.max(MIN_CHAT, total.width - MIN_PREVIEW - DIVIDER)
    setChatWidth(Math.max(MIN_CHAT, Math.min(max, next)))
  }
  const onPointerUp = (e: React.PointerEvent) => {
    if (!dragging) return
    ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    setDragging(false)
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const total = mainRef.current?.getBoundingClientRect().width ?? 0
    const step = e.shiftKey ? 40 : 10
    const max = Math.max(MIN_CHAT, total - MIN_PREVIEW - DIVIDER)
    setChatWidth((w) => Math.max(MIN_CHAT, Math.min(max, w + (e.key === 'ArrowLeft' ? -step : step))))
  }

  return (
    <section className="grid h-full grid-rows-[1fr] min-h-0">
      <main
        ref={mainRef}
        className="relative grid h-full min-h-0 min-w-0"
        style={{ gridTemplateColumns: `${chatWidth}px 1px 1fr` }}
      >
        <section className="grid grid-rows-[1fr_auto] min-h-0 bg-bg">
          <ChatList />
          <Composer />
        </section>
        <div
          role="separator"
          aria-orientation="vertical"
          tabIndex={0}
          className={cn(
            'relative cursor-col-resize select-none bg-line transition-colors',
            'hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2',
            dragging && 'bg-accent',
            // 12px hit area extending leftward into chat-pane.
            "before:content-[''] before:absolute before:inset-y-0 before:right-0 before:w-3 before:bg-transparent",
          )}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onKeyDown}
        />
        <section ref={previewRef} className="relative bg-bg-deep" />
      </main>
    </section>
  )
}
