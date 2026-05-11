// Theme IPC. Mirrors `src/main/ipc/i18n.ts`:
//
//   theme:get      — renderer pulls { pref, resolved } at boot
//   theme:set-pref — user picked a theme in Settings; main persists,
//                    syncs nativeTheme.themeSource, and broadcasts the
//                    new state via `app:theme-changed` (also fires when
//                    pref === 'auto' and the OS appearance changes,
//                    via main's `nativeTheme.on('updated')` listener)

import { ipcMain } from 'electron'
import { chromeOnly } from '#/main/ipc/guard.ts'
import { broadcastToChromeWebContents } from '#/main/window-registry.ts'
import { getTheme, setThemePref, subscribeTheme, type ThemePref } from '#/main/theme.ts'

export function wireThemeIpc(): void {
  ipcMain.handle(
    'theme:get',
    chromeOnly(() => getTheme()),
  )

  ipcMain.handle(
    'theme:set-pref',
    chromeOnly(async (_event, pref: unknown) => {
      if (pref !== 'auto' && pref !== 'light' && pref !== 'dark') {
        throw new Error(`Unknown theme pref: ${String(pref)}`)
      }
      // setThemePref emits to subscribers — the broadcast bridge below
      // forwards every change to renderers, so we don't need to fan out
      // manually here. Returning the new state is mostly informational;
      // the renderer applies it via the broadcast path, not the IPC
      // reply.
      return await setThemePref(pref as ThemePref)
    }),
  )

  // One-time subscription bridges the in-process listener bus to the
  // chrome IPC fan-out. Keeping this here (rather than inside theme.ts)
  // keeps the theme module pure — testable without an Electron IPC
  // mock — and confines ipc imports to the ipc directory.
  subscribeTheme((state) => {
    broadcastToChromeWebContents('app:theme-changed', [state])
  })
}
