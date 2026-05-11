import { nativeTheme, type TitleBarOverlayOptions } from 'electron'
import { TOPBAR_PX } from '#/main/window-layout.ts'

/**
 * Window chrome strategy per platform.
 *
 * The Deck App is a single-window application (one `BaseWindow` hosting
 * one or more `WebContentsView`s), so there is only one chrome strategy
 * per platform — "appChrome" — shared by the launcher / player / editor
 * modes within that window. See docs/window-chrome.md for rationale.
 */

export type Platform = 'mac' | 'win' | 'linux'

const PLATFORM: Platform = ((): Platform => {
  switch (process.platform) {
    case 'darwin':
      return 'mac'
    case 'win32':
      return 'win'
    default:
      return 'linux'
  }
})()

// OS caption buttons strip height on Win/Linux. Must match the CSS
// topbar height (App.tsx grid row) or the deckView overlaps / leaves a
// gap below the buttons. Sourced from TOPBAR_PX so the three places
// that need to agree (this overlay, the CSS grid row, and the macOS
// trafficLightPosition centering math) all read from one constant.
const OVERLAY_HEIGHT = TOPBAR_PX

/**
 * Overlay color for an explicit theme. Used for both the app window chrome
 * (launcher / editor background) and, in player mode, a translucent tint
 * so caption buttons stay readable against arbitrary deck backgrounds.
 */
export function overlayForTheme(dark: boolean): TitleBarOverlayOptions {
  return dark
    ? { color: '#000000', symbolColor: '#ffffff', height: OVERLAY_HEIGHT }
    : { color: '#ffffff', symbolColor: '#000000', height: OVERLAY_HEIGHT }
}

export function initialOverlay(): TitleBarOverlayOptions {
  return overlayForTheme(nativeTheme.shouldUseDarkColors)
}

export interface AppChrome {
  titleBarStyle: 'hiddenInset' | 'hidden'
  initialOverlay: () => TitleBarOverlayOptions | undefined
  /**
   * Whether the native OS menu bar is hidden by default. macOS has no
   * per-window menu bar (always in the system bar), so this is `false`
   * there. Windows/Linux use `true`: a self-drawn menu lives in the
   * topbar (see src/renderer/components/AppMenu.tsx), and we call
   * `setMenuBarVisibility(false)` on the window to suppress the native
   * bar entirely — the native `Menu` is still installed via
   * `Menu.setApplicationMenu` so global accelerators stay bound.
   */
  hideNativeMenuBar: boolean
}

export const supportsOverlayThemeUpdates: boolean = PLATFORM !== 'mac'

const MAC: AppChrome = {
  titleBarStyle: 'hiddenInset',
  initialOverlay: () => undefined,
  hideNativeMenuBar: false,
}

const WIN: AppChrome = {
  titleBarStyle: 'hidden',
  initialOverlay,
  hideNativeMenuBar: true,
}

// Field-for-field copy of WIN: Linux tracking Windows is an explicit
// decision, not an accidental reference. See docs/window-chrome.md §Linux.
const LINUX: AppChrome = {
  titleBarStyle: 'hidden',
  initialOverlay,
  hideNativeMenuBar: true,
}

const STRATEGIES: Record<Platform, AppChrome> = {
  mac: MAC,
  win: WIN,
  linux: LINUX,
}

export const appChrome: AppChrome = STRATEGIES[PLATFORM]
