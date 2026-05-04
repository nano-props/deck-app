import { nativeTheme, type TitleBarOverlayOptions } from 'electron'

/**
 * Window chrome strategy per platform.
 *
 * This module is the single source of truth for how the Launcher and Player
 * windows are framed on each OS. Every platform is listed explicitly — there
 * is no shared else-branch — so that:
 *
 * 1. Adding a new field to the strategy surfaces a TS error on every platform
 *    that doesn't declare it (exhaustive `Record<Platform, ...>`).
 * 2. Changing the value for one platform can't silently affect another.
 * 3. "Linux inherits Windows" is an intentional decision written in code,
 *    not a side effect of grouping everything non-macOS into one branch.
 *
 * See docs/window-chrome.md for the design rationale behind each strategy.
 */

export type Platform = 'mac' | 'win' | 'linux'

const PLATFORM: Platform = ((): Platform => {
  switch (process.platform) {
    case 'darwin':
      return 'mac'
    case 'win32':
      return 'win'
    default:
      // freebsd / openbsd / etc. all map to Linux behavior. The Deck App
      // isn't built for those, but if Electron happens to boot on one,
      // Linux is the least-wrong default.
      return 'linux'
  }
})()

// --- Overlay color helpers (Windows / Linux) ---------------------------------

const OVERLAY_HEIGHT = 32

/**
 * Launcher overlay adapted to an explicit theme ('dark' / 'light'). The
 * Launcher renderer owns theme state and reports its pick via IPC, at which
 * point the main process calls `applyChromeTheme` → this helper →
 * `setTitleBarOverlay`.
 */
export function launcherOverlayForTheme(dark: boolean): TitleBarOverlayOptions {
  return dark
    ? { color: '#000000', symbolColor: '#ffffff', height: OVERLAY_HEIGHT }
    : { color: '#ffffff', symbolColor: '#000000', height: OVERLAY_HEIGHT }
}

/**
 * Best-effort initial overlay seed for the Launcher at window-create time,
 * before the renderer has booted and IPC'd its persisted theme choice. If the
 * user's saved pick differs from the current system theme there may be a
 * brief flash on launch — accepted for simplicity.
 */
export function launcherInitialOverlay(): TitleBarOverlayOptions {
  return launcherOverlayForTheme(nativeTheme.shouldUseDarkColors)
}

/**
 * Player overlay. Semi-transparent dark tint (`#00000040`, ~25% alpha) so the
 * white caption button symbols stay readable against any deck background. A
 * fully transparent overlay worked for black-backgrounded decks but made the
 * symbols invisible as soon as a deck painted a light background.
 *
 * No per-deck theming today; a future `deck.json` `theme` field could drive
 * this dynamically.
 */
const PLAYER_OVERLAY: TitleBarOverlayOptions = {
  color: '#00000040',
  symbolColor: '#ffffff',
  height: OVERLAY_HEIGHT,
}

// --- Strategy shape ----------------------------------------------------------

export interface LauncherChrome {
  titleBarStyle: 'hiddenInset' | 'hidden'
  /**
   * Thunk so the system theme is read at window-create time, not at module
   * load — `nativeTheme.shouldUseDarkColors` is only reliable after
   * `app.whenReady()`. Returns `undefined` on platforms that don't use
   * `titleBarOverlay` (macOS).
   */
  initialOverlay: () => TitleBarOverlayOptions | undefined
  autoHideMenuBar: boolean
}

export interface PlayerChrome {
  titleBarStyle: 'hiddenInset' | 'hidden'
  overlay: TitleBarOverlayOptions | undefined
  autoHideMenuBar: boolean
  /**
   * Whether to inject the author-page drag strip. macOS needs it because
   * `hiddenInset`'s OS-native drag region can be stolen by fixed-position
   * author elements. Windows/Linux use `titleBarOverlay`, which natively
   * sits above web contents.
   */
  injectDragStrip: boolean
}

interface ChromeStrategy {
  launcher: LauncherChrome
  player: PlayerChrome
}

/**
 * Whether `setTitleBarOverlay` is meaningful on this platform. macOS
 * doesn't use `titleBarOverlay`, so calls would throw / no-op. Windows and
 * Linux both route theme changes through the overlay.
 *
 * Platform capability (true for every window on the platform), hoisted out
 * of the per-window strategies so callers that handle both Launcher and
 * Player can reuse the same flag.
 */
export const supportsOverlayThemeUpdates: boolean = PLATFORM !== 'mac'

// --- Per-platform strategies -------------------------------------------------

const MAC: ChromeStrategy = {
  launcher: {
    titleBarStyle: 'hiddenInset',
    initialOverlay: () => undefined,
    autoHideMenuBar: false,
  },
  player: {
    titleBarStyle: 'hiddenInset',
    overlay: undefined,
    autoHideMenuBar: false,
    injectDragStrip: true,
  },
}

const WIN: ChromeStrategy = {
  launcher: {
    titleBarStyle: 'hidden',
    initialOverlay: launcherInitialOverlay,
    autoHideMenuBar: true,
  },
  player: {
    titleBarStyle: 'hidden',
    overlay: PLAYER_OVERLAY,
    autoHideMenuBar: true,
    injectDragStrip: false,
  },
}

// Linux currently mirrors the Windows strategy field-for-field. Written out
// as a full copy (not `= WIN`) so that changing a Windows value here is a
// conscious, visible decision about whether Linux should track it — no
// accidental coupling through a shared object. See docs/window-chrome.md
// §Linux for known gaps and candidate fixes when Linux becomes an actively
// supported target.
const LINUX: ChromeStrategy = {
  launcher: {
    titleBarStyle: 'hidden',
    initialOverlay: launcherInitialOverlay,
    autoHideMenuBar: true,
  },
  player: {
    titleBarStyle: 'hidden',
    overlay: PLAYER_OVERLAY,
    autoHideMenuBar: true,
    injectDragStrip: false,
  },
}

const STRATEGIES: Record<Platform, ChromeStrategy> = {
  mac: MAC,
  win: WIN,
  linux: LINUX,
}

const CURRENT = STRATEGIES[PLATFORM]

export const launcherChrome: LauncherChrome = CURRENT.launcher
export const playerChrome: PlayerChrome = CURRENT.player
