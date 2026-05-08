// Main-process i18n.
//
// One in-memory `currentLang` mirrors the user's setting (settings.ui.lang
// resolved against `app.getLocale()` if 'auto'). Reads go through `t(key, params)`;
// a setter notifies subscribers (menu rebuild + IPC broadcast to renderers).
// The renderer holds its own copy of the dictionary fetched via IPC; this
// module is the source of truth.

import { app } from 'electron'
import { en, type DictKey } from '#/main/i18n/en.ts'
import { ko } from '#/main/i18n/ko.ts'
import { zh } from '#/main/i18n/zh.ts'

export type Lang = 'en' | 'zh' | 'ko'
export type LangPref = Lang | 'auto'

const DICTS: Record<Lang, Record<DictKey, string>> = { en, zh, ko }

export const SUPPORTED_LANGS: readonly Lang[] = ['en', 'zh', 'ko'] as const

let currentLang: Lang = 'en'

/**
 * Verify every non-en dictionary has the same keys as en. Catches the
 * silent-fallback class of bug where a translator forgets to copy a
 * new key — `t()` would return the en string at runtime, hiding the
 * miss until somebody happens to switch language and notice.
 *
 * Throws in dev (so first-run after adding a key fails fast); warns in
 * production (one missing key shouldn't refuse to boot a packaged app).
 * Call once at startup.
 */
export function assertDictionaryParity(isDev: boolean): void {
  const enKeys = new Set(Object.keys(en) as DictKey[])
  const issues: string[] = []
  for (const lang of ['zh', 'ko'] as const) {
    const dict = DICTS[lang] as Record<string, string>
    const dictKeys = new Set(Object.keys(dict))
    for (const k of enKeys) {
      if (!dictKeys.has(k)) issues.push(`${lang}: missing key "${k}"`)
    }
    for (const k of dictKeys) {
      if (!enKeys.has(k as DictKey)) issues.push(`${lang}: stray key "${k}" not in en`)
    }
  }
  if (issues.length === 0) return
  const msg = `[i18n] dictionary parity broken:\n  ${issues.join('\n  ')}`
  if (isDev) throw new Error(msg)
  console.warn(msg)
}

/**
 * Map an OS locale (BCP 47, e.g. 'en-US', 'zh-CN', 'ko-KR') to one of our
 * supported langs. Falls back to 'en'. `app.getLocale()` is what Chromium
 * negotiated at startup — close enough to "what the user reads in".
 */
export function resolveLang(pref: LangPref): Lang {
  if (pref === 'en' || pref === 'zh' || pref === 'ko') return pref
  const sys = (app.getLocale() || 'en').toLowerCase()
  if (sys.startsWith('zh')) return 'zh'
  if (sys.startsWith('ko')) return 'ko'
  return 'en'
}

/** Set the active language. Idempotent. Callers (settings IPC, boot)
 *  drive their own follow-up actions (rebuild menu, broadcast dictionary). */
export function setCurrentLang(lang: Lang): void {
  if (currentLang === lang) return
  currentLang = lang
}

export function getCurrentLang(): Lang {
  return currentLang
}

/**
 * Translate a key. `params` does `{name}` substitution — kept tiny because
 * we don't need plurals or genders. Falls back to en, then to the raw key
 * (so an untranslated key surfaces visibly in the UI).
 */
export function t(key: DictKey, params?: Record<string, string | number>): string {
  const dict = DICTS[currentLang]
  const raw = dict[key] ?? en[key] ?? String(key)
  if (!params) return raw
  return raw.replace(/\{(\w+)\}/g, (m, name) => {
    const v = params[name]
    return v == null ? m : String(v)
  })
}

/** Full dictionary for the current language — used by IPC to seed the renderer. */
export function getDictionary(): Record<DictKey, string> {
  return DICTS[currentLang]
}
