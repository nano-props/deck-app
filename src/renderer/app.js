// Single-window chrome renderer — boot + topbar + sub-view toggle.
//
// The deckView is a WebContentsView managed by main. This file never
// touches it directly — reload / chat-width changes cross IPC.
//
// Feature code lives in `ui/*.js`:
//   - state.js        — shared `state` + IPC `onState` subscription
//   - theme.js        — auto/light/dark preference
//   - launcher.js     — the pre-deck view (recents, open buttons, i18n)
//   - chat.js         — AI chat + event dispatch + send
//   - attachments.js  — composer drag/paste/chip staging
//   - divider.js      — chat/preview splitter + `setChatWidth`
//   - settings.js     — modal overlay + AI provider form
//
// Each module self-registers its DOM listeners at import time. Anything
// that must wait for boot (i18n render, theme apply, initial chat-width
// hydrate) is exported as an `initX()` and called below.

import './ui/attachments.js'
import './ui/chat.js'
import './ui/menu.js'
import './ui/settings.js'
import { initDivider, setChatWidth } from './ui/divider.js'
import { initLauncher } from './ui/launcher.js'
import { onStateChange, refreshState, state } from './ui/state.js'
import { initTheme } from './ui/theme.js'

const body = document.body
const deckNameEl = document.getElementById('deckName')
const modeToggleBtn = document.getElementById('modeToggle')
const reloadBtn = document.getElementById('reloadBtn')
const exportBtn = document.getElementById('exportBtn')
const launcherLoading = document.getElementById('launcherLoading')

// ---- State → DOM -----------------------------------------------------------

/** Apply the latest `state` to the bits of DOM owned by this file: body
 *  data-attributes (which CSS uses to swap modes), the deck name in the
 *  topbar, the launcher loading overlay, and the chat-width CSS var.
 *  Sub-systems (launcher recents list, chat replay, etc.) subscribe via
 *  `onStateChange` directly. */
function applyStateToDom() {
  body.setAttribute('data-mode', state.mode)
  body.setAttribute('data-subview', state.subView)
  body.toggleAttribute('data-fullscreen', !!state.isFullScreen)
  deckNameEl.textContent = state.deck ? (state.deck.manifest?.name ?? 'Deck') : 'Deck'
  updateModeToggleLabel()
  launcherLoading.hidden = !(state.mode === 'launcher' && state.loading)
  if (typeof state.chatWidth === 'number' && state.mode === 'deck' && state.subView === 'edit') {
    setChatWidth(state.chatWidth, { silent: true })
  }
}
onStateChange(applyStateToDom)

// ---- Sub-view switcher -----------------------------------------------------

/**
 * Switch sub-views. No animation — the main process briefly hides the
 * deckView (a native WebContentsView) across the relayout so the user
 * doesn't see it jump between Edit and Play positions. During that gap
 * the DOM's own background shows, which is already the right color for
 * the incoming layout since `data-subview` flipped synchronously.
 */
async function switchSubView(target) {
  if (state.subView === target) return
  if (target === 'play') await window.deck.enterPlayer()
  else await window.deck.enterEditor()
}

/** Refresh the toggle button's tooltip to advertise the target sub-view. */
function updateModeToggleLabel() {
  const target = state.subView === 'edit' ? 'Play' : 'Edit'
  modeToggleBtn.title = target
  modeToggleBtn.setAttribute('aria-label', `Switch to ${target}`)
}

modeToggleBtn.addEventListener('click', () => {
  void switchSubView(state.subView === 'edit' ? 'play' : 'edit')
})
reloadBtn.addEventListener('click', () => window.deck.reloadPreview())
exportBtn.addEventListener('click', () => window.deck.exportDeck())

// ---- Boot ------------------------------------------------------------------

initLauncher()
initTheme()
initDivider()
refreshState()
