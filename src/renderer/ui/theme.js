import { LS } from './state.js'

// Theme preference: 'auto' | 'light' | 'dark'. 'auto' follows the system.
// The resolved concrete theme is applied to <html data-theme> and
// forwarded to main so the native title-bar overlay can recolor too.

const systemDark = matchMedia('(prefers-color-scheme: dark)')
const themeSeg = document.getElementById('themeSeg')

function resolveTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref
  return systemDark.matches ? 'dark' : 'light'
}
function applyThemePref(pref) {
  const resolved = resolveTheme(pref)
  document.documentElement.setAttribute('data-theme', resolved)
  window.deck.setChromeTheme?.(resolved)
  themeSeg.querySelectorAll('[data-theme-value]').forEach((b) => {
    b.setAttribute('aria-checked', b.dataset.themeValue === pref ? 'true' : 'false')
  })
}
function setThemePref(pref) {
  localStorage.setItem(LS.theme, pref)
  applyThemePref(pref)
}
function currentThemePref() {
  const v = localStorage.getItem(LS.theme)
  return v === 'light' || v === 'dark' || v === 'auto' ? v : 'auto'
}

export function initTheme() {
  applyThemePref(currentThemePref())
  systemDark.addEventListener?.('change', () => {
    if (currentThemePref() === 'auto') applyThemePref('auto')
  })
  themeSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-theme-value]')
    if (!btn) return
    setThemePref(btn.dataset.themeValue)
  })
}
