/**
 * Shared layout constants for AppWindow + chrome.
 *
 * Layout math lives in the renderer (CSS); main only sizes the
 * chromeView. The deckView's bounds are pushed from the renderer
 * (CSS grid → ResizeObserver → IPC), so a single source of truth
 * (CSS) drives both the DOM and the native overlay, eliminating the
 * cross-layer race that produced sub-view transition flashes.
 */

/**
 * Height in CSS px of the app's topbar. The three sites that depend on
 * the value all import this constant — keep it that way so any change
 * is a single edit:
 *   - App.tsx: root grid row `${TOPBAR_PX}px 1fr`
 *   - chrome-strategy.ts: `OVERLAY_HEIGHT` for the Win/Linux titleBarOverlay
 *   - app-window/index.ts: macOS trafficLightPosition centering math
 *
 * 32px matches Windows 11 DWM caption height and Linear / Figma's
 * topbar. On macOS this is taller than the 28px native titlebar, so we
 * explicitly center the traffic lights with `trafficLightPosition` — see
 * BaseWindow constructor.
 */
export const TOPBAR_PX = 32
