// The deck stage — fixed-position iframe overlay covering the page
// while a deck is active.
//
// The iframe ref is hoisted to the parent (PlayerPage) because Loader
// owns its `.src` directly (mid-load it sets `about:blank`, on commit
// it sets `./deck/<id>/index.html`). Exposing the ref through forwardRef
// keeps Loader's imperative handle clean while letting React control
// mount.

import { forwardRef } from 'react'

interface StageProps {
  active: boolean
}

export const Stage = forwardRef<HTMLIFrameElement, StageProps>(function Stage(
  { active },
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
    </div>
  )
})
