// Player — empty container; main overlays the deckView (a native
// WebContentsView) on top of this rect. We just provide the geometry
// for `preview-bounds` to measure.

import { useDeckPreviewBounds } from '#/renderer/hooks/useDeckPreviewBounds.ts'

export function Player() {
  const ref = useDeckPreviewBounds()
  return <section ref={ref} className="block h-full bg-bg" />
}
