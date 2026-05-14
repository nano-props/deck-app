// Bottom-anchored undo toast — quiet card style, NOT a banner.
// Animation:
//   - Mount: opacity 0→1, slide up 12px
//   - Progress bar: scaleX(1) → scaleX(0) over TOAST_TIMEOUT_MS,
//     started one frame after mount so the transform actually animates
//     instead of jumping.

import { useEffect, useRef, useState } from 'react'
import { useI18n } from '#/web/lib/i18n.ts'
import { toast, useToast, TOAST_TIMEOUT_MS } from '#/web/player/undo-toast.ts'

export function UndoToast() {
  const t = useI18n((s) => s.t)
  const spec = useToast()
  const [active, setActive] = useState(false)
  const progressRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!spec) {
      setActive(false)
      return
    }
    setActive(true)

    // Reset progress bar to scale 1 with no transition, then on the
    // next frame switch transition on and scale to 0 — same trick the
    // vanilla version uses (forced reflow via offsetWidth read). React
    // can't observe layout effects in time, so we touch the DOM
    // directly. Cleanup is implicit: the bar is unmounted with the
    // toast.
    const bar = progressRef.current
    if (bar) {
      bar.style.transition = 'none'
      bar.style.transform = 'scaleX(1)'
      // Force layout so the transition swap below picks up the
      // current value as its starting point. Without this the
      // browser may collapse both styles into one paint and skip the
      // animation.
      void bar.offsetWidth
      bar.style.transition = `transform ${TOAST_TIMEOUT_MS}ms linear`
      bar.style.transform = 'scaleX(0)'
    }
  }, [spec])

  return (
    <div
      role="status"
      aria-live="polite"
      className={
        // active class drives both the slide-up and the pointer-events
        // gate (so the toast can't intercept clicks while invisible).
        // Transition lists `translate` (not `transform`) — Tailwind v4
        // emits CSS-native `translate` for `-translate-x-1/2` /
        // `translate-y-*`, and a `transition: transform` would never
        // see the change.
        'fixed left-1/2 bottom-6 z-[200] min-w-[280px] max-w-[calc(100vw-32px)] bg-surface text-ink border border-line rounded-[10px] shadow-card transition-[opacity,translate] duration-[180ms] ease-out overflow-hidden ' +
        (active
          ? 'opacity-100 -translate-x-1/2 translate-y-0 pointer-events-auto'
          : 'opacity-0 -translate-x-1/2 translate-y-3 pointer-events-none')
      }
    >
      <div className="flex items-center gap-3 pl-[14px] pr-1.5 py-2.5">
        <span className="flex-1 min-w-0 text-sm text-ink-2 whitespace-nowrap overflow-hidden text-ellipsis">
          {spec?.message}
        </span>
        <button
          type="button"
          onClick={() => toast.undo()}
          className="shrink-0 bg-transparent border-0 px-3 py-1.5 text-accent font-semibold cursor-pointer rounded-md transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
        >
          {t('toastUndo')}
        </button>
      </div>
      <div
        ref={progressRef}
        // --color-mute (3:1 contrast) is visible against white but
        // doesn't compete with the message text the way --color-accent
        // would.
        className="h-0.5 bg-mute origin-left will-change-transform"
      />
    </div>
  )
}
