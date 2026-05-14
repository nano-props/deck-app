// The deck stage — fixed-position iframe overlay with a "home indicator"
// pill at the bottom-center that opens the command palette.
//
// The iframe ref is hoisted to the parent (PlayerPage) because Loader
// owns its `.src` directly (mid-load it sets `about:blank`, on commit
// it sets `./deck/<id>/index.html`). Exposing the ref through forwardRef
// keeps Loader's imperative handle clean while letting React control
// mount.
//
// `mix-blend-mode: difference` on the home indicator auto-inverts
// against any deck background. SOLID white fill (no alpha) keeps the
// blend stable — alpha + difference produces washed-out colors that
// shift on every paint. Hover/active are opacity-only for the same
// reason.

import { forwardRef } from 'react'

interface StageProps {
  active: boolean
  onIndicatorClick: () => void
}

export const Stage = forwardRef<HTMLIFrameElement, StageProps>(function Stage(
  { active, onIndicatorClick },
  ref,
) {
  return (
    <div
      // Stage z-index sits above the topbar (z-5) so the upload screen
      // is fully obscured. We deliberately do NOT use a `:has(.active)`
      // sibling rule on the body — that triggers a global style
      // recalculation which lags one frame behind on Safari and
      // produces a brief white flash when closing a deck.
      className="fixed inset-0 z-50 bg-surface"
      style={{ display: active ? 'block' : 'none' }}
    >
      <iframe
        ref={ref}
        // sandbox: allow-same-origin is required so the deck's bundled
        // scripts can use storage/fetch normally and so the SW can
        // intercept its same-origin requests. Combined with
        // allow-scripts this means the iframe is NOT meaningfully
        // sandboxed from the player — treat decks as trusted code.
        sandbox="allow-scripts allow-same-origin"
        // allow="fullscreen": presentations commonly use the Fullscreen
        // API to go edge-to-edge. Without this attribute
        // iframe.requestFullscreen() rejects.
        allow="fullscreen"
        className="w-full h-full border-0"
      />
      <button
        type="button"
        onClick={onIndicatorClick}
        aria-label="Open command palette"
        title="Open command palette (⌘K)"
        // mix-blend-mode requires solid white fill (NOT alpha) for
        // stable blending. Translucency comes from `opacity` instead.
        // Tailwind doesn't ship `mix-blend-difference` as `mix-blend-*`
        // by default in v4 prebuilds, so we drop to inline style for
        // that one property.
        // active state mirrors the iPhone home-indicator press: scaleY
        // squashes the pill 60% vertically. transition lists `scale`
        // (CSS native, what `active:scale-y-*` emits in v4); opacity
        // covers hover. translate doesn't change after mount, so it's
        // not in the transition list.
        className="fixed left-1/2 bottom-2 -translate-x-1/2 z-10 w-[120px] h-[5px] p-0 m-0 rounded-full bg-white border-0 cursor-pointer opacity-45 hover:opacity-85 active:scale-y-[0.6] transition-[opacity,scale] duration-[160ms] focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-4 focus-visible:[isolation:isolate]"
        style={{ mixBlendMode: 'difference' }}
      />
    </div>
  )
})
