// Hook that sends the host element's geometry to main as `setPreviewBounds`.
//
// CSS owns layout in the React shell; main only mirrors what we measure.
// We observe size changes (window resize, splitter drag, fullscreen
// toggle) and the element's mount/unmount (mode switch). The first push
// happens via the initial ResizeObserver fire after the element is
// painted.

import { useCallback, useEffect, useRef } from 'react'

export function useDeckPreviewBounds() {
  const ref = useRef<HTMLElement | null>(null)
  const lastSentRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null)

  const measureAndPush = useCallback(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return
    const rect = {
      x: Math.round(r.left),
      y: Math.round(r.top),
      width: Math.round(r.width),
      height: Math.round(r.height),
    }
    const last = lastSentRef.current
    if (
      last &&
      last.x === rect.x &&
      last.y === rect.y &&
      last.w === rect.width &&
      last.h === rect.height
    ) {
      return
    }
    lastSentRef.current = { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
    void window.deck.setPreviewBounds(rect)
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => measureAndPush())
    ro.observe(el)
    // First push immediately — rAF gives the browser a frame to lay out.
    requestAnimationFrame(measureAndPush)
    return () => {
      ro.disconnect()
      // Reset dedup so the next mount (different deck / sub-view) is
      // guaranteed to push at least once.
      lastSentRef.current = null
    }
  }, [measureAndPush])

  // Window resize re-measures even when the box itself didn't change
  // size relative to its parent (e.g. fullscreen toggles).
  useEffect(() => {
    const onResize = () => measureAndPush()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [measureAndPush])

  return (node: HTMLElement | null) => {
    ref.current = node
    if (node) requestAnimationFrame(measureAndPush)
  }
}
