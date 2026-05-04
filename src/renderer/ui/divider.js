import { LS } from './state.js'

// Splitter between chat-pane and preview-pane in Edit sub-view. The
// visible grid track is only 1px; a 12px-wide absolute-positioned hit
// area extends left into chat-pane to give the user a comfortable drag
// target (preview-pane hosts a native WebContentsView that would eat
// pointer events).
//
// `setChatWidth` is also called from the state listener in app.js when
// main echoes back a chat-width (e.g. another window pushed a change).

const editorMain = document.getElementById('editorMain')
const divider = document.getElementById('divider')

const MIN_CHAT_WIDTH = 280
const MIN_PREVIEW_WIDTH = 320
const DIVIDER_WIDTH = 1 // grid slot width; hit area is an absolute overlay

function clampChatWidth(px) {
  const total = editorMain.getBoundingClientRect().width
  if (total === 0) return px // not yet laid out
  const max = Math.max(MIN_CHAT_WIDTH, total - MIN_PREVIEW_WIDTH - DIVIDER_WIDTH)
  return Math.max(MIN_CHAT_WIDTH, Math.min(max, px))
}

/**
 * Write the chat-pane width to the CSS variable and (unless `silent`)
 * persist it back to main. `silent: true` is used when the update comes
 * FROM main so we don't bounce the value back.
 */
export function setChatWidth(px, { silent = false } = {}) {
  editorMain.style.setProperty('--chat-width', px + 'px')
  if (!silent) window.deck.setChatWidth?.(px)
}

let dragState = null
divider.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  divider.setPointerCapture(e.pointerId)
  const mainRect = editorMain.getBoundingClientRect()
  dragState = { pointerId: e.pointerId, mainLeft: mainRect.left }
  divider.classList.add('dragging')
})
divider.addEventListener('pointermove', (e) => {
  if (!dragState || e.pointerId !== dragState.pointerId) return
  setChatWidth(clampChatWidth(e.clientX - dragState.mainLeft))
})
function endDrag(e) {
  if (!dragState || e.pointerId !== dragState.pointerId) return
  divider.releasePointerCapture(dragState.pointerId)
  divider.classList.remove('dragging')
  dragState = null
  const cur = parseFloat(getComputedStyle(editorMain).getPropertyValue('--chat-width')) || 0
  if (cur > 0) localStorage.setItem(LS.chatWidth, String(Math.round(cur)))
}
divider.addEventListener('pointerup', endDrag)
divider.addEventListener('pointercancel', endDrag)
divider.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  e.preventDefault()
  const step = e.shiftKey ? 40 : 10
  const cur = parseFloat(getComputedStyle(editorMain).getPropertyValue('--chat-width')) || 0
  const next = clampChatWidth(cur + (e.key === 'ArrowLeft' ? -step : step))
  setChatWidth(next)
  localStorage.setItem(LS.chatWidth, String(Math.round(next)))
})
window.addEventListener('resize', () => {
  const cur = parseFloat(getComputedStyle(editorMain).getPropertyValue('--chat-width')) || 0
  const clamped = clampChatWidth(cur)
  if (clamped !== cur) setChatWidth(clamped)
})

/** Restore saved chat width on boot. Scheduled via rAF so the editor
 *  pane has actually been laid out (otherwise clampChatWidth sees
 *  `total === 0` and bails out with the raw value). */
export function initDivider() {
  const saved = Number(localStorage.getItem(LS.chatWidth))
  requestAnimationFrame(() => {
    const initial = Number.isFinite(saved) && saved > 0 ? clampChatWidth(saved) : clampChatWidth(532)
    setChatWidth(initial)
  })
}
