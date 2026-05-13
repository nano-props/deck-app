// Deck Web Player — entry point and coordinator.
//
// This module wires together independent pieces. Anything substantial
// lives behind one of the imports:
//
//   loader.js       deck loading lifecycle (hash → unpack → register
//                   → cache → stage), plus SW restart recovery
//   router.js       URL hash ↔ load/close routing
//   cache.js        Cache API + LRU + soft-delete plumbing
//   sw-client.js    Service Worker registration and protocol
//   recents-ui.js   "Recently opened" list view
//   palette-ui.js   ⌘K command palette
//   undo-toast.js   timed undo notification
//
// Invariants:
//   - deckId is the SHA-256/96-bit prefix of the .deck bytes (hex).
//   - Stage active ⟺ loader.currentDeckId is non-null and the SW has
//     the corresponding file table registered.
//   - Only Loader mutates currentDeckId; everything else either reads
//     it or asks Loader to commit/close.
//
// JSZip is loaded as a UMD global from index.html; sw-client.js uses
// `window.JSZip` directly.

import {
  softDeleteDeck,
  restoreDeck,
  commitDeleteDeck,
} from './cache.js'
import { Loader } from './loader.js'
import { createRouter } from './router.js'
import { renderRecents } from './recents-ui.js'
import { Palette } from './palette-ui.js'
import { getToast } from './undo-toast.js'

// --- DOM refs ----------------------------------------------------

const dropEl = document.getElementById('drop')
const fileInput = document.getElementById('file')
const stageEl = document.getElementById('stage')
const frameEl = document.getElementById('frame')
const statusEl = document.getElementById('status')
const errorEl = document.getElementById('error')
const recentsEl = document.getElementById('recents')

// --- Status / error display -------------------------------------

// Status and error are mutually exclusive: setting one clears the
// other so users never see "Loading…" alongside a final error.
function setStatus(msg) {
  statusEl.textContent = msg || ''
  if (msg) errorEl.textContent = ''
}
function setError(msg) {
  errorEl.textContent = msg || ''
  if (msg) statusEl.textContent = ''
}

// --- Loader (deck lifecycle) -------------------------------------

const loader = new Loader({
  frameEl,
  stageEl,
  setStatus,
  setError,
  onStageShown: (_deckId, manifestName) => {
    document.title = (manifestName || 'Deck') + ' — Deck Player'
    // Drop the inline "restoring" cloak (set in <head> when the URL
    // had a hash on first load). The stage now covers the upload
    // screen anyway, but we don't want the cloak lingering for the
    // eventual back navigation.
    document.documentElement.classList.remove('restoring')
  },
  onClosed: () => {
    document.title = 'Deck Player'
    setStatus('')
    document.documentElement.classList.remove('restoring')
    refreshRecents()
  },
  onLoadFailed: () => {
    // The "restoring" cloak is set in <head> when the URL has a hash;
    // a refresh that hits a real error needs the cloak dropped so
    // the user can see the message instead of a blank page.
    document.documentElement.classList.remove('restoring')
  },
})

// --- Router (URL hash) -------------------------------------------

const router = createRouter({
  onHash: async (hash) => {
    const result = await loader.loadFromHash(hash)
    if (result === 'missing') {
      // Strip the dangling hash, collapse the stage, and surface a
      // clear explanation. close() bumps generation + fires onClosed,
      // which clears status; setError after that.
      router.clearHash()
      loader.close()
      setError(
        'This deck is not on this device. The URL only restores decks ' +
          'cached locally — it cannot be shared with others. ' +
          'Drop the .deck file to load it.',
      )
    }
  },
  onEmpty: () => loader.close(),
})

// --- Recents list (upload screen) --------------------------------

function refreshRecents() {
  renderRecents(recentsEl, { onOpen: openRecent, onDelete: handleDelete })
    .catch((err) => console.error(err))
}

async function openRecent(deckId) {
  if (deckId === loader.currentDeckId) return
  router.pushHash(deckId)
  await loader.loadFromHash(deckId)
}

const toast = getToast(document.getElementById('undo-toast'))

// Soft-delete with a 6-second undo window. The cached blob is left
// alone until commit, so an undo simply reinstates the LRU pointer
// (no need to re-cache the actual zip).
function handleDelete(deckId, name) {
  const entry = softDeleteDeck(deckId)
  if (!entry) return
  refreshRecents()

  toast.show({
    message: 'Removed “' + (name || 'deck') + '”',
    onUndo: () => {
      restoreDeck(deckId, entry)
      refreshRecents()
    },
    onCommit: () => {
      // Pass the soft-deleted entry: if the user has since re-opened
      // the same deck, the LRU will have a newer ts and commit will
      // be a no-op so we don't wipe the freshly-loaded deck.
      commitDeleteDeck(deckId, entry).catch((err) => {
        console.error('Failed to commit deck deletion:', err)
      })
    },
  })
}

// --- File picker / drag & drop -----------------------------------

dropEl.addEventListener('dragover', (e) => {
  e.preventDefault()
  dropEl.classList.add('hover')
})
dropEl.addEventListener('dragleave', () => dropEl.classList.remove('hover'))
dropEl.addEventListener('drop', (e) => {
  e.preventDefault()
  dropEl.classList.remove('hover')
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]
  loader.loadFromFile(file)
})

fileInput.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0]
  loader.loadFromFile(file)
  // Reset so picking the same file twice in a row still fires `change`.
  e.target.value = ''
})

// "Choose a .deck file" button forwards to the hidden <input>. We
// intentionally don't use a <label for="file"> wrapper — that pattern
// can double-fire the file picker when the input also lives inside
// the label. Explicit click() is unambiguous.
document.getElementById('browse').addEventListener('click', () => {
  fileInput.click()
})

// --- Command palette ---------------------------------------------

// Cmd/Ctrl+K or "?" while a deck is showing. The "home indicator"
// pill at the bottom of the stage opens it on click — this is the
// only entry point that works regardless of where keyboard focus
// currently lives (inside the iframe, keys don't reach this window).
const palette = new Palette({
  root: document.getElementById('palette'),
  body: document.getElementById('palette-body'),
  onBack: () => {
    router.clearHash()
    loader.close()
  },
  onOpenDeck: (deckId) => openRecent(deckId),
})

document.getElementById('home-indicator').addEventListener('click', () => {
  if (loader.hasActiveDeck) palette.toggle()
})

window.addEventListener('keydown', (e) => {
  if (palette.handleKey(e)) {
    e.preventDefault()
    return
  }
  // Don't intercept while the user is typing into a form field.
  const t = e.target
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
  if (!loader.hasActiveDeck) return

  const isMod = e.metaKey || e.ctrlKey
  if ((isMod && e.key.toLowerCase() === 'k') || (!isMod && e.key === '?')) {
    e.preventDefault()
    palette.toggle()
  }
})

// --- Escape hatch: ?unregister=1 ---------------------------------
// If the player is ever taken down or fundamentally broken, users
// would otherwise be stuck — the SW remains registered and the cache
// keeps eating disk forever. Visiting `?unregister=1` runs a one-shot
// teardown: unregister all SWs at this scope, drop the deck blob
// cache, and wipe the LRU bookkeeping. We never proceed to normal
// startup on that path — the page just shows a confirmation.
async function handleEscapeHatch() {
  const inner = dropEl.querySelector('.inner')
  if (inner) {
    inner.replaceChildren(
      Object.assign(document.createElement('h1'), { textContent: 'Deck Player' }),
      Object.assign(document.createElement('p'), {
        id: 'status',
        textContent: 'Cleaning up Deck Player data…',
      }),
    )
  }

  const errors = []
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations()
      await Promise.all(regs.map((r) => r.unregister().catch((e) => errors.push(e))))
    }
  } catch (err) { errors.push(err) }
  try {
    if (window.caches) await caches.delete('deck-blobs-v1')
  } catch (err) { errors.push(err) }
  try {
    localStorage.removeItem('deck-cache-lru-v2')
  } catch (err) { errors.push(err) }

  if (errors.length) console.error('Cleanup errors:', errors)

  const msg = inner && inner.querySelector('#status')
  if (msg) {
    msg.textContent = errors.length
      ? 'Cleanup completed with some errors (see console). You can close this tab.'
      : 'Deck Player data has been removed. You can close this tab.'
  }
}

// --- Boot --------------------------------------------------------

if (new URLSearchParams(location.search).get('unregister') === '1') {
  handleEscapeHatch()
} else {
  router.start()
}
