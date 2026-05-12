// DeckShell — left chat-pane (chat list + composer) | divider |
// right preview-pane. Always mounted while in deck mode; the same
// component serves both edit and play sub-views. Entering play just
// collapses the chat-pane to width 0 with a CSS transition, so the
// underlying BrowserView (right preview) grows continuously into full
// width — no component swap, no flicker.
//
// `chatWidth` is persisted in localStorage and clamped to the
// shell's actual width. Divider drag updates the local state;
// everything else is flex-driven.

import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '#/renderer/stores/app.ts'
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

export function DeckShell() {
  const mainRef = useRef<HTMLDivElement>(null)
  const previewRef = useDeckPreviewBounds()
  const [chatWidth, setChatWidth] = useState<number>(readSavedWidth)
  const [dragging, setDragging] = useState(false)
  const isPlaying = useAppStore((s) => s.subView === 'play')

  // Clamp on every relevant change (mount, container resize, drag).
  // The shell width is the source of truth; we never let chat go past
  // total - MIN_PREVIEW - DIVIDER.
  //
  // ResizeObserver on `<main>` rather than window.resize: the latter
  // misses cases where the window is unchanged but the host box did
  // resize (devtools docked, future surrounding chrome, etc.). RO fires
  // synchronously once on observe, which seeds the initial clamp.
  useEffect(() => {
    const el = mainRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const total = el.getBoundingClientRect().width
      if (total === 0) return
      const max = Math.max(MIN_CHAT, total - MIN_PREVIEW - DIVIDER)
      setChatWidth((w) => Math.max(MIN_CHAT, Math.min(max, w)))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Persist with a 250ms idle debounce. localStorage.setItem is
  // synchronous IO; writing it 60×/s during a pointer drag costs real
  // frames. Idle-trailing means the final width survives, but the
  // intermediate values during a drag don't hit disk. Skip the
  // initial run so we don't write back the value we just read.
  const firstPersistRef = useRef(true)
  useEffect(() => {
    if (firstPersistRef.current) {
      firstPersistRef.current = false
      return
    }
    const timer = setTimeout(() => {
      localStorage.setItem(LS_KEY, String(Math.round(chatWidth)))
    }, 250)
    return () => clearTimeout(timer)
  }, [chatWidth])

  // If an external trigger flips us into play mid-drag (menu shortcut,
  // IPC), captured pointers keep delivering `pointermove` regardless
  // of the divider's `pointer-events: none` (capture bypasses
  // hit-testing). Clearing `dragging` makes those events no-ops so
  // they can't pollute `chatWidth` while the user finishes their
  // gesture; the explicit capture itself releases automatically on
  // the next pointerup per the W3C pointer-events spec.
  useEffect(() => {
    if (isPlaying && dragging) setDragging(false)
  }, [isPlaying, dragging])

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
    if (isPlaying) return
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const total = mainRef.current?.getBoundingClientRect().width ?? 0
    const step = e.shiftKey ? 40 : 10
    const max = Math.max(MIN_CHAT, total - MIN_PREVIEW - DIVIDER)
    setChatWidth((w) => Math.max(MIN_CHAT, Math.min(max, w + (e.key === 'ArrowLeft' ? -step : step))))
  }

  // Chat pane width animates between `chatWidth` (edit) and 0 (play).
  // While dragging the divider, disable the width transition so the
  // cursor tracks 1:1 instead of lerping behind. Timing comes from
  // `--duration-pane` / `--ease-standard` in styles.css (Material/Apple
  // standard easing — symmetric in/out, the desktop convention for
  // sidebar collapse).
  // The divider rides the same width transition AND keeps a separate
  // background-color transition for hover/dragging color feedback (an
  // inline `transition` overrides the className `transition-colors`,
  // so we must declare both here).
  const chatPaneWidth = isPlaying ? 0 : chatWidth
  const dividerWidth = isPlaying ? 0 : DIVIDER
  const widthTransition = dragging
    ? 'none'
    : 'width var(--duration-pane) var(--ease-standard)'
  const dividerTransition = dragging
    ? 'background-color 150ms'
    : 'width var(--duration-pane) var(--ease-standard), background-color 150ms'

  return (
    <section className="grid h-full grid-rows-[1fr] min-h-0">
      <main ref={mainRef} className="relative flex h-full min-h-0 min-w-0">
        <aside
          className="bg-bg overflow-hidden shrink-0 [contain:layout]"
          style={{ width: chatPaneWidth, transition: widthTransition }}
          inert={isPlaying}
        >
          {/* Inner wrapper width: in edit (and while dragging the divider)
           * we follow the aside (100%) so chat content reflows correctly
           * with the container. During the edit→play→edit collapse the
           * aside animates between `chatWidth` and 0; we freeze the inner
           * at `chatWidth` then so the chat content doesn't reflow each
           * animation frame — it's just clipped by `overflow: hidden` on
           * the aside. */}
          <div
            className="grid grid-rows-[1fr_auto] h-full min-h-0"
            style={{ width: isPlaying ? chatWidth : '100%' }}
          >
            <ChatList />
            <Composer />
          </div>
        </aside>
        <div
          role="separator"
          aria-orientation="vertical"
          tabIndex={isPlaying ? -1 : 0}
          className={cn(
            'relative cursor-col-resize select-none bg-line shrink-0',
            'hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2',
            dragging && 'bg-accent',
            // 4px hit area extending leftward — kept narrow so it
            // doesn't overlap the chat-pane's overlay scrollbar rail.
            "before:content-[''] before:absolute before:inset-y-0 before:right-0 before:w-1 before:bg-transparent",
          )}
          style={{
            width: dividerWidth,
            transition: dividerTransition,
            pointerEvents: isPlaying ? 'none' : 'auto',
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onKeyDown}
        />
        <section ref={previewRef} className="relative flex-1 min-w-0 bg-bg-deep" />
      </main>
    </section>
  )
}
