import type { BrowserWindow } from 'electron'
import type { DeckDragMode } from '#/main/deck-types.ts'

// Leaf-level `no-drag` wins over an ancestor `drag` on Electron 23+, so
// authors can override any rule here with their own `-webkit-app-region`.
const AUTO_DRAG_CSS = [
  'html, body { -webkit-app-region: drag; }',
  'a, button, input, textarea, select, label,',
  'video, audio, iframe, embed, object,',
  '[role="button"], [role="link"], [role="textbox"], [role="slider"],',
  '[role="checkbox"], [role="radio"], [role="menuitem"], [role="tab"],',
  '[contenteditable]:not([contenteditable="false"])',
  '{ -webkit-app-region: no-drag; }',
].join('\n')

// insertCSS is scoped to the current document, so re-run on every nav.
// did-finish-load fires on the initial load AND subsequent navigations.
export function installDragRegions(win: BrowserWindow, mode: DeckDragMode): void {
  if (mode === 'off') return
  win.webContents.on('did-finish-load', () => {
    win.webContents.insertCSS(AUTO_DRAG_CSS).catch(() => {
      // webContents gone (window destroyed, renderer crashed) — cosmetic
      // failure, not worth surfacing.
    })
  })
}
