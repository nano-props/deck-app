/**
 * Shared layout constants + stateless helpers for AppWindow geometry.
 *
 * These live outside `app-window.ts` so:
 *   - CSS / preload / docs can reference a single source of truth
 *     (especially `TOPBAR_PX`, which must match `body grid-template-rows`
 *     in `src/renderer/app.css`);
 *   - layout math can be unit-tested without mounting a BaseWindow.
 */

/**
 * Height in CSS px of the app's topbar. MUST stay in sync with:
 *   - app.css: body `grid-template-rows: <TOPBAR_PX>px 1fr`
 *   - chrome-strategy.ts: `OVERLAY_HEIGHT` (Win/Linux titleBarOverlay height)
 *
 * 32px matches Windows 11 DWM caption height and Linear / Figma's
 * topbar. On macOS this is taller than the 28px native titlebar, so we
 * explicitly center the traffic lights with `trafficLightPosition` — see
 * BaseWindow constructor. 28px was too tight for traffic-light clearance
 * and left the icon buttons cramped.
 */
export const TOPBAR_PX = 32

/**
 * Width of the splitter's grid slot between chat and preview panes.
 * Only 1px — just the visible line. The draggable hit area is an
 * absolute-positioned DOM overlay that extends leftward into chat-pane
 * (preview-pane hosts a native WebContentsView that would eat clicks,
 * so the overlay cannot cross into it). deckView starts immediately
 * after the 1px line.
 *
 * MUST stay in sync with:
 *   - app.css: `.editor-main` grid-template-columns middle track
 *   - app.js: DIVIDER_WIDTH
 */
export const SPLITTER_PX = 1

/** Default chat-pane width when the user hasn't dragged the splitter yet. */
export const DEFAULT_CHAT_WIDTH = Math.round(1400 * 0.38) // ≈ 532

/** Minimum chat-pane width before we stop shrinking it. */
export const MIN_CHAT_WIDTH = 280

/** Minimum preview-pane width — keeps the iframe legible during drag. */
export const MIN_PREVIEW_WIDTH = 320

/**
 * Clamp a desired chat-pane width into the range admitted by the current
 * window content width. Pure function — no side effects, no dependency
 * on BaseWindow, safe to call from the renderer's divider-drag code via
 * IPC or from `applyLayout` in main.
 */
export function clampChatWidth(px: number, windowContentWidth: number): number {
  const max = Math.max(MIN_CHAT_WIDTH, windowContentWidth - MIN_PREVIEW_WIDTH)
  return Math.max(MIN_CHAT_WIDTH, Math.min(max, px))
}
