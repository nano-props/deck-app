// Naive-ui-style custom scroller: native overflow stays in the content
// container (so wheel / touchpad / keyboard / programmatic scrollTop all
// work unchanged), but the native scrollbar is hidden and a thin overlay
// rail+thumb mirrors the scroll state.
//
// Behavior:
//   - thumb height = (clientHeight / scrollHeight) * railHeight, min 20px
//   - rail fades in on hover and during active scrolling (1s idle hide)
//   - thumb drag updates scrollTop with frozen thumb height (no jitter
//     when content grows mid-drag)
//   - empty-rail clicks page by ~one viewport in the click direction
//
// Forwards the inner scroll element via `scrollRef` so the parent can do
// imperative scrollTop writes (auto-follow tail in ChatList).

import { useEffect, useRef, type ReactNode, type RefObject } from 'react'
import { cn } from '#/renderer/lib/cn.ts'

const MIN_THUMB = 20
const IDLE_MS = 1000
const PAGE_RATIO = 0.9

interface ScrollerProps {
  /** Forwarded to the inner overflow element. ChatList writes scrollTop on it. */
  scrollRef?: RefObject<HTMLDivElement | null>
  /** onScroll fires for each native scroll event on the inner element. */
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void
  /** Click delegation — same semantics as plain <div onClick>. */
  onClick?: (e: React.MouseEvent<HTMLDivElement>) => void
  className?: string
  children: ReactNode
}

export function Scroller({ scrollRef, onScroll, onClick, className, children }: ScrollerProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const railRef = useRef<HTMLDivElement>(null)
  const thumbRef = useRef<HTMLDivElement>(null)

  // Forward inner element to parent via the optional ref. innerRef is a
  // stable mutable object so this is a one-time setup; rerun if the
  // parent swaps in a different `scrollRef` (rare but cheap).
  useEffect(() => {
    if (scrollRef && 'current' in scrollRef) {
      ;(scrollRef as { current: HTMLDivElement | null }).current = innerRef.current
    }
  }, [scrollRef])

  useEffect(() => {
    const content = innerRef.current
    const rail = railRef.current
    const thumb = thumbRef.current
    if (!content || !rail || !thumb) return

    let drag: { pointerOffsetInThumb: number; thumbH: number } | null = null
    let idleTimer: ReturnType<typeof setTimeout> | null = null

    const update = () => {
      const { scrollTop, scrollHeight, clientHeight } = content
      const railH = rail.clientHeight
      if (scrollHeight <= clientHeight || railH <= 0) {
        thumb.style.display = 'none'
        return
      }
      thumb.style.display = ''
      const rawH = (clientHeight / scrollHeight) * railH
      // Freeze thumb height during a drag so streaming/resizes don't shift
      // the cached pointerOffsetInThumb out from under us.
      const thumbH = drag ? drag.thumbH : Math.max(rawH, MIN_THUMB)
      const travel = railH - thumbH
      const maxScroll = scrollHeight - clientHeight
      const ratio = maxScroll > 0 ? scrollTop / maxScroll : 0
      thumb.style.height = `${thumbH}px`
      thumb.style.transform = `translateY(${travel * ratio}px)`
    }

    const markScrolling = () => {
      rail.classList.add('scrolling')
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        rail.classList.remove('scrolling')
        idleTimer = null
      }, IDLE_MS)
    }

    const onScrollNative = () => {
      update()
      markScrolling()
    }

    // Content growth from streamed tokens / appended messages doesn't
    // fire `scroll` — observe the subtree so the thumb tracks scrollHeight.
    const mo = new MutationObserver(update)
    mo.observe(content, { childList: true, subtree: true, characterData: true })
    const ro = new ResizeObserver(update)
    ro.observe(content)
    if (rootRef.current) ro.observe(rootRef.current)

    content.addEventListener('scroll', onScrollNative)

    // Thumb drag — global listeners attached only for the drag's lifetime.
    const onMove = (e: MouseEvent) => {
      if (!drag) return
      const railRect = rail.getBoundingClientRect()
      const travel = railRect.height - drag.thumbH
      if (travel <= 0) return
      const y = e.clientY - railRect.top - drag.pointerOffsetInThumb
      const clamped = Math.max(0, Math.min(travel, y))
      const ratio = clamped / travel
      const maxScroll = content.scrollHeight - content.clientHeight
      content.scrollTop = ratio * maxScroll
    }
    const onUp = () => {
      if (!drag) return
      drag = null
      rail.classList.remove('active')
      document.body.style.userSelect = ''
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      update()
    }
    const onThumbDown = (e: MouseEvent) => {
      e.preventDefault()
      const thumbRect = thumb.getBoundingClientRect()
      drag = {
        pointerOffsetInThumb: e.clientY - thumbRect.top,
        thumbH: thumbRect.height,
      }
      rail.classList.add('active')
      document.body.style.userSelect = 'none'
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    }
    thumb.addEventListener('mousedown', onThumbDown)

    // Empty-rail paging: click above/below the thumb scrolls by ~viewport.
    const onRailDown = (e: MouseEvent) => {
      if (e.target !== rail) return
      if (thumb.style.display === 'none') return
      const railRect = rail.getBoundingClientRect()
      const thumbRect = thumb.getBoundingClientRect()
      const clickY = e.clientY - railRect.top
      const thumbTop = thumbRect.top - railRect.top
      const delta = content.clientHeight * PAGE_RATIO
      content.scrollTop += clickY < thumbTop ? -delta : delta
    }
    rail.addEventListener('mousedown', onRailDown)

    update()

    return () => {
      mo.disconnect()
      ro.disconnect()
      content.removeEventListener('scroll', onScrollNative)
      thumb.removeEventListener('mousedown', onThumbDown)
      rail.removeEventListener('mousedown', onRailDown)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      if (idleTimer) clearTimeout(idleTimer)
      if (drag) document.body.style.userSelect = ''
    }
  }, [])

  return (
    <div ref={rootRef} className={cn('group/scroller relative min-h-0 overflow-hidden', className)}>
      <div
        ref={innerRef}
        onScroll={onScroll}
        onClick={onClick}
        className={cn(
          'h-full overflow-y-scroll',
          // Hide native scrollbar — overlay rail/thumb does the visuals.
          '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        )}
      >
        {children}
      </div>
      <div
        ref={railRef}
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute right-0.5 top-0.5 bottom-0.5 w-2',
          'opacity-0 transition-opacity duration-300',
          // Visible on container hover, during drag (.active), and while
          // scrolling (.scrolling). The classes are toggled imperatively
          // in the effect above.
          'group-hover/scroller:opacity-100 group-hover/scroller:pointer-events-auto',
          '[&.active]:opacity-100 [&.active]:pointer-events-auto',
          '[&.scrolling]:opacity-100 [&.scrolling]:pointer-events-auto',
        )}
      >
        <div
          ref={thumbRef}
          className={cn(
            'absolute inset-x-0 rounded',
            'bg-ink-4 opacity-35 transition-[background,opacity] duration-200',
            'hover:opacity-55 hover:bg-ink-3',
          )}
        />
      </div>
    </div>
  )
}
