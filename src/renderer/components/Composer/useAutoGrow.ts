import { useLayoutEffect, useRef, type RefObject } from 'react'

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

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
    if (pendingCaretRef.current !== null) {
      const pos = pendingCaretRef.current
      pendingCaretRef.current = null
      el.setSelectionRange(pos, pos)
    }
  }, [ref, text])

  return {
    setPendingCaret: (pos) => {
      pendingCaretRef.current = pos
    },
  }
}
