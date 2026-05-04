import { LS, onStateChange, state } from './state.js'

// Launcher surface: the three action buttons, the recents list, window-
// level drag-drop (only fires when no deck is loaded), and the en/zh
// copy table. Nothing in this module is active once a deck is open —
// it's gated by `state.mode === 'launcher'`.

const body = document.body

// ---- Element handles -------------------------------------------------------

const newDeckBtn = document.getElementById('newDeck')
const openFileBtn = document.getElementById('openFile')
const openFolderBtn = document.getElementById('openFolder')
const recentsSection = document.getElementById('recents')
const recentsList = document.getElementById('recentsList')

// ---- Buttons ---------------------------------------------------------------

newDeckBtn.addEventListener('click', () => window.deck.newDeck())
openFileBtn.addEventListener('click', () => window.deck.openDialog())
openFolderBtn.addEventListener('click', () => window.deck.openFolder())

// ---- Recents ---------------------------------------------------------------

async function refreshRecents() {
  try {
    const list = await window.deck.listRecents()
    renderRecents(list)
  } catch {
    recentsSection.hidden = true
  }
}

function pathKindIcon(path) {
  // If it ends in .deck, it's a file (pack). Else folder.
  const isPack = path.toLowerCase().endsWith('.deck')
  return isPack
    ? '<svg class="kind-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>'
    : '<svg class="kind-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
}

function shortenPath(p) {
  const home = p.startsWith('/Users/') || p.startsWith('/home/') ? p.split('/').slice(0, 3).join('/') : null
  if (home && p.startsWith(home)) return '~' + p.slice(home.length)
  return p
}

function renderRecents(list) {
  if (!list || list.length === 0) {
    recentsSection.hidden = true
    return
  }
  recentsSection.hidden = false
  recentsList.innerHTML = ''
  for (const r of list) {
    const li = document.createElement('li')
    li.className = 'recent-item'
    li.innerHTML = `
      ${pathKindIcon(r.path)}
      <span class="recent-name"></span>
      <span class="recent-path"></span>
      <button class="icon-btn forget" type="button" title="Remove from list" aria-label="Remove from list">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    `
    li.querySelector('.recent-name').textContent = r.name || '(unnamed)'
    li.querySelector('.recent-path').textContent = shortenPath(r.path)
    li.addEventListener('click', (e) => {
      // Ignore clicks on the forget button.
      if (e.target.closest('.forget')) return
      window.deck.openPath(r.path)
    })
    const forget = li.querySelector('.forget')
    forget.addEventListener('click', async (e) => {
      e.stopPropagation()
      await window.deck.forgetRecent(r.path)
      void refreshRecents()
    })
    recentsList.appendChild(li)
  }
}

// Refresh the list whenever the window returns to launcher mode. Runs on
// both the initial `refreshState()` and any subsequent `onState` push.
onStateChange((s) => {
  if (s.mode === 'launcher') void refreshRecents()
})

// ---- Drag + drop (only when no deck is loaded; drops replace the slot) -----

for (const evt of ['dragenter', 'dragover']) {
  window.addEventListener(evt, (e) => {
    e.preventDefault()
    if (state.mode === 'launcher') body.classList.add('drag')
  })
}
window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) body.classList.remove('drag')
})
window.addEventListener('drop', (e) => {
  e.preventDefault()
  body.classList.remove('drag')
  if (state.mode !== 'launcher') return
  const files = e.dataTransfer?.files
  if (!files || files.length === 0) return
  for (const f of files) window.deck.openDroppedFile(f)
})

// ---- Launcher i18n ---------------------------------------------------------

const I18N = {
  en: {
    title: 'Open a deck.',
    lede: 'Pick a file or folder. Or just drag one in.',
    newDeck: 'New deck',
    openFile: 'Open file',
    openFolder: 'Open folder',
    recent: 'Recent',
    loading: 'Opening…',
  },
  zh: {
    title: '打开一份 Deck。',
    lede: '选一个文件或文件夹，或者直接拖进来。',
    newDeck: '新建',
    openFile: '打开文件',
    openFolder: '打开文件夹',
    recent: '最近打开',
    loading: '正在打开…',
  },
}
function detectLang() {
  const saved = localStorage.getItem(LS.lang)
  if (saved && I18N[saved]) return saved
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language || 'en']
  for (const l of langs) {
    const low = (l || '').toLowerCase()
    if (low.startsWith('zh')) return 'zh'
    if (low.startsWith('en')) return 'en'
  }
  return 'en'
}
function applyI18n(lang) {
  localStorage.setItem(LS.lang, lang)
  document.documentElement.setAttribute('lang', lang === 'zh' ? 'zh-CN' : 'en')
  const dict = I18N[lang] || I18N.en
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n')
    const val = dict[key] !== undefined ? dict[key] : I18N.en[key]
    if (val !== undefined) el.textContent = val
  })
}

export function initLauncher() {
  applyI18n(detectLang())
}
