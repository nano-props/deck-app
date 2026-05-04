import type { BrowserWindow } from 'electron'

// Height of the drag strip at the top of the Player window. Matches the
// Windows `titleBarOverlay.height` (32px) so the reserved top band is the
// same on both platforms.
const STRIP_HEIGHT_PX = 32

// The Player uses `titleBarStyle: 'hiddenInset'` on macOS, which gives
// the OS-native drag region around the traffic lights. But the web
// contents still overlay the whole window, so any `position: fixed;
// top: 0` element in the author page (e.g. a Next.js nav bar) steals
// pointer events from that native drag region and the window becomes
// un-draggable by the header.
//
// This injects a transparent, top-of-stack DOM strip marked
// `-webkit-app-region: drag`. Because drag regions sit above pointer
// events in Chromium's hit testing, the strip wins over any author
// element in the top 32px. The strip is only visible as "swallowed
// clicks" in that band — nothing else about the author page changes.
//
// Platform gating lives in the caller (`chrome-strategy.ts` →
// `playerChrome.injectDragStrip`): Windows/Linux use `titleBarOverlay`
// which natively sits above web contents, so they don't need this.
const STRIP_ID = '__deck_drag_strip__'
const STRIP_SCRIPT = `
(() => {
  const ID = ${JSON.stringify(STRIP_ID)};
  const H = ${STRIP_HEIGHT_PX};
  const mount = () => {
    if (document.getElementById(ID)) return;
    const el = document.createElement('div');
    el.id = ID;
    el.style.cssText = [
      'position:fixed',
      'top:0',
      'left:0',
      'right:0',
      'height:' + H + 'px',
      'z-index:2147483647',
      '-webkit-app-region:drag',
      'pointer-events:auto',
    ].join(';');
    (document.body || document.documentElement).appendChild(el);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
})();
`

/**
 * Inject a top-of-window drag strip into the Player's author page.
 *
 * This function does not gate on platform — callers must check
 * `playerChrome.injectDragStrip` first. Invoking it on Windows/Linux
 * would layer a redundant (and click-swallowing) strip on top of the
 * titleBarOverlay, so don't.
 *
 * `did-finish-load` fires on the initial load AND on full-document
 * navigations (e.g. `location.href = ...`, MPA page transitions). It does
 * NOT fire on SPA client-side routing (Next.js `router.push`, `<Link>`,
 * React Router, etc.), but that's fine: SPA routing keeps `<body>`
 * intact, so the previously-injected strip survives the transition. The
 * script is idempotent (sentinel ID) so repeat calls don't stack elements.
 */
export function installDragStrip(win: BrowserWindow): void {
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(STRIP_SCRIPT).catch(() => {
      // webContents gone (window destroyed, renderer crashed) — cosmetic
      // failure, not worth surfacing.
    })
  })
}
