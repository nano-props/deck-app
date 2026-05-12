// i18n store — mirrors main's dictionary cache and exposes a `t()` helper.
//
// The dictionary is fetched once at boot (window.deck.i18n.get()) and
// re-populated whenever the user picks a different language. Components
// hook in via `useI18n(s => s.t)` (re-renders only when the dict
// changes) or read `getT()` for non-reactive call sites.

import { create } from 'zustand'
import type { DictKey } from '#/main/i18n/en.ts'
import type { Lang, LangPref } from '#/main/i18n/index.ts'

type Dict = Partial<Record<DictKey, string>>

interface I18nStore {
  lang: Lang
  pref: LangPref
  dict: Dict
  t: (key: DictKey, params?: Record<string, string | number>) => string
  /** Set the user preference. Round-trips through main, which broadcasts
   *  the resulting dict back via `onChange`. */
  setPref: (pref: LangPref) => Promise<void>
  /** Internal — applied on `app:i18n-changed` and the boot fetch. */
  _apply: (payload: { lang: Lang; pref: LangPref; dict: Dict }) => void
}

function format(raw: string, params?: Record<string, string | number>): string {
  if (!params) return raw
  return raw.replace(/\{(\w+)\}/g, (m, name) => {
    const v = params[name]
    return v == null ? m : String(v)
  })
}

function makeT(dict: Dict): I18nStore['t'] {
  return (key, params) => format(dict[key] ?? key, params)
}

export const useI18n = create<I18nStore>((set) => ({
  lang: 'en',
  pref: 'auto',
  dict: {},
  // Bound to the current `dict` so its identity changes on every language
  // swap — components selecting `s.t` re-render on switch. A `get().dict`
  // closure would keep the same reference forever and silently skip the
  // re-render.
  t: makeT({}),
  setPref: async (pref) => {
    // Optimistic: main will broadcast the canonical state back; we wait
    // for that rather than mutating locally. Errors swallowed — the
    // current language stays in place.
    await window.deck.i18n.setPref(pref).catch(() => {})
  },
  _apply: ({ lang, pref, dict }) => {
    set({ lang, pref, dict, t: makeT(dict) })
    // Reflect on <html lang> so screen readers / spell checkers pick the
    // right language. BCP 47-ish.
    document.documentElement.setAttribute('lang', lang === 'zh' ? 'zh-CN' : lang === 'ko' ? 'ko-KR' : 'en')
  },
}))

window.deck.i18n.onChange((payload) => {
  if (payload) useI18n.getState()._apply(payload)
})

// Boot fetch. Components that render before this resolves see the raw
// English keys — same one-frame flash the old vanilla code accepted.
void window.deck.i18n.get().then((payload) => {
  if (payload) useI18n.getState()._apply(payload)
})

/** Non-reactive `t()` for call sites outside React render (event
 *  handlers, console-bound logs, etc.). Re-reads the current `t`
 *  closure each call — DO NOT cache the return value, since each `t`
 *  is bound to the dict that was active when it was created. Use as
 *  `getT()(key)` at the call site. Components should still subscribe
 *  via `useI18n(s => s.t)`. */
export function getT() {
  return useI18n.getState().t
}
