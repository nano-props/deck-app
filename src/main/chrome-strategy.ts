import { nativeTheme, type TitleBarOverlayOptions } from 'electron'

/**
 * Window chrome strategy per platform.
 *
 * The Deck App is a single-window application (one `BaseWindow` hosting
 * one or more `WebContentsView`s), so there is only one chrome strategy
 * per platform — "appChrome" — shared by the launcher / player / editor
 * modes within that window. See docs/window-chrome.md for rationale.
 *
 * `playerExtras` carries mode-specific tweaks (currently just: whether
 * macOS needs the drag strip injected into the full-bleed deck view in
 * player mode — see src/main/player-titlebar.ts).
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

// Keep in sync with app-window.ts::TOPBAR_PX — this is the OS caption
// buttons strip height on Win/Linux, and must match the CSS topbar
// height or the deckView overlaps / leaves a gap below the buttons.
const OVERLAY_HEIGHT = 32

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
   * topbar (see src/renderer/ui/menu.js), and we call
   * `setMenuBarVisibility(false)` on the window to suppress the native
   * bar entirely — the native `Menu` is still installed via
   * `Menu.setApplicationMenu` so global accelerators stay bound.
   */
  hideNativeMenuBar: boolean
  /**
   * In player mode the deckView covers the whole content area. On macOS
   * `hiddenInset` gives a native drag region around the traffic lights,
   * but author `position: fixed; top: 0` elements steal hit-testing. We
   * inject a transparent `-webkit-app-region: drag` strip (see
   * src/main/player-titlebar.ts). Windows/Linux use `titleBarOverlay`
   * which natively sits above web contents, so no injection needed.
   */
  playerInjectDragStrip: boolean
}

export const supportsOverlayThemeUpdates: boolean = PLATFORM !== 'mac'

const MAC: AppChrome = {
  titleBarStyle: 'hiddenInset',
  initialOverlay: () => undefined,
  hideNativeMenuBar: false,
  playerInjectDragStrip: true,
}

const WIN: AppChrome = {
  titleBarStyle: 'hidden',
  initialOverlay,
  hideNativeMenuBar: true,
  playerInjectDragStrip: false,
}

// Field-for-field copy of WIN: Linux tracking Windows is an explicit
// decision, not an accidental reference. See docs/window-chrome.md §Linux.
const LINUX: AppChrome = {
  titleBarStyle: 'hidden',
  initialOverlay,
  hideNativeMenuBar: true,
  playerInjectDragStrip: false,
}

const STRATEGIES: Record<Platform, AppChrome> = {
  mac: MAC,
  win: WIN,
  linux: LINUX,
}

export const appChrome: AppChrome = STRATEGIES[PLATFORM]
