import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

/**
 * Auto-grow the textarea up to its CSS max-height. Chromium 134+
 * supports `field-sizing: content` which would do this for us — but
 * running this on every text change is dirt cheap and keeps behavior
 * identical across Electron versions. useLayoutEffect (not useEffect)
 * so the height adjustment runs before paint — otherwise typing past
 * the line break would flash a 1-line height for a frame.
 *
 * The same effect also lands any pending caret position. Setting
 * selection straight after setText (queueMicrotask / setTimeout) races
 * React's commit — el.value is still the old text and the selection
 * lands at the wrong offset. useLayoutEffect runs after commit but
 * before paint, so el.value reflects the new text and selection sticks.
 */
export function useAutoGrow(
  ref: RefObject<HTMLTextAreaElement | null>,
  text: string,
): { setPendingCaret: (pos: number) => void } {
  const pendingCaretRef = useRef<number | null>(null)

  const recompute = () => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }

  useLayoutEffect(() => {
    recompute()
    const el = ref.current
    if (el && pendingCaretRef.current !== null) {
      const pos = pendingCaretRef.current
      pendingCaretRef.current = null
      el.setSelectionRange(pos, pos)
    }
  }, [ref, text])

  // Width changes (chat pane resize, window resize) re-wrap the text;
  // the height set above is in px against the *old* width, so without
  // this the textarea would clip to an internal scrollbar instead of
  // growing to fit the re-wrapped lines.
  //
  // We watch only the inline-size (= width here) and ignore block-size
  // changes the height write itself produces — otherwise the RO would
  // re-fire for our own writes and tip into the "loop completed with
  // undelivered notifications" warning.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let lastWidth = el.clientWidth
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const width = entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width
      if (width === lastWidth) return
      lastWidth = width
      recompute()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])

  return {
    setPendingCaret: (pos) => {
      pendingCaretRef.current = pos
    },
  }
}
