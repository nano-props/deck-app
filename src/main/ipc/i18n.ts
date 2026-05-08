import { ipcMain } from 'electron'
import { chromeOnly } from '#/main/ipc/guard.ts'
import {
  getCurrentLang,
  getDictionary,
  resolveLang,
  setCurrentLang,
  SUPPORTED_LANGS,
  type Lang,
  type LangPref,
} from '#/main/i18n/index.ts'
import { buildMenu } from '#/main/menu/index.ts'
import { getSettings, updateSettings } from '#/main/settings.ts'
import { allAppWindows } from '#/main/window-registry.ts'

/**
 * i18n channels.
 *
 *   i18n:get      — renderer pulls { lang, pref, dict } on boot.
 *   i18n:set-pref — user picked a language in Settings. Persists to settings.json,
 *                   updates main's `currentLang`, rebuilds the menu, and broadcasts
 *                   `app:i18n-changed` to every chrome WebContents.
 */
export function wireI18nIpc(): void {
  ipcMain.handle(
    'i18n:get',
    chromeOnly(async () => {
      const settings = await getSettings()
      return {
        lang: getCurrentLang(),
        pref: settings.ui.lang,
        dict: getDictionary(),
      }
    }),
  )

  ipcMain.handle(
    'i18n:set-pref',
    chromeOnly(async (_event, pref: unknown) => {
      if (pref !== 'auto' && !(SUPPORTED_LANGS as readonly string[]).includes(pref as string)) {
        throw new Error(`Unknown lang pref: ${String(pref)}`)
      }
      const typed = pref as LangPref
      await updateSettings({ ui: { lang: typed } })
      const resolved: Lang = resolveLang(typed)
      setCurrentLang(resolved)
      buildMenu()
      // Broadcast to every chromeView so renderers can re-apply translations.
      // Payload mirrors `i18n:get` so the renderer can hot-swap its dict
      // without a follow-up round-trip.
      const payload = { lang: resolved, pref: typed, dict: getDictionary() }
      for (const w of allAppWindows()) {
        if (w.isDestroyed()) continue
        const wc = w.getChromeWebContents()
        if (wc.isDestroyed()) continue
        wc.send('app:i18n-changed', payload)
      }
      return payload
    }),
  )
}
