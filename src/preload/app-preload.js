// Single app preload. Loaded as CJS via the sibling package.json
// (type: commonjs).
//
// Exposes every surface the chrome UI needs under window.deck.
const { contextBridge, ipcRenderer, shell, webUtils } = require('electron')
const { marked } = require('marked')
const createDOMPurify = require('dompurify')

// ---- Markdown rendering -----------------------------------------------------
//
// AI assistant text is emitted by the model as Markdown (headings, lists,
// code fences, bold/italic, inline code, links). Rendering it safely in
// renderer requires a parser + sanitizer. Both run here in preload's
// isolated world, where we have access to `window.document` (shared DOM
// between preload and renderer) and to node's `require`. The renderer
// only sees `renderMarkdown(md) → html string` — it never needs to import
// marked/dompurify itself, so the CSP `script-src 'self'` stays clean.
//
// marked config notes:
//   - `gfm: true`     — tables, task lists, autolinks.
//   - `breaks: true`  — render single '\n' as <br>. LLM output often
//                       formats inline paragraphs that way.
//   - No `highlight`  — we don't bundle a syntax highlighter. Code blocks
//                       render as monospace; highlighting is an open-ended
//                       dependency cost we're not ready to pay yet.
// `async: false` pins `marked.parse` to the synchronous string return
// shape. Marked v18's union type includes `Promise<string>` for async
// extensions — if we ever let one slip through, sanitizing a Promise
// (which would toString into "[object Promise]") is a silent-failure
// class we want to lock out now.
marked.setOptions({ gfm: true, breaks: true, async: false })

let purifier = null
function getPurifier() {
  // Instantiate lazily: DOMPurify needs a live `window` with `document`
  // and `DOMParser`. At preload exec time the DOM may not yet be fully
  // ready (it is by the time we first render a message, which is after
  // DOMContentLoaded + IPC history replay). Caching the instance keeps
  // the hot path allocation-free.
  if (purifier) return purifier
  purifier = createDOMPurify(window)
  // Open links in the OS browser rather than navigating chromeView.
  // `addHook('afterSanitizeAttributes')` runs on every element after
  // DOMPurify has finished its own attribute filtering — we just mark
  // <a> elements so chromeView's click handler can intercept them.
  // We don't set `target="_blank"` because the renderer has its own
  // click handler that calls `shell.openExternal` — setting target here
  // would additionally pop a chromeView popup we'd have to suppress.
  purifier.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.hasAttribute('href')) {
      node.setAttribute('rel', 'noopener noreferrer')
      node.setAttribute('data-external', '')
    }
  })
  return purifier
}

/**
 * Parse a Markdown string to sanitized HTML. Exposed to the renderer as
 * `window.deck.renderMarkdown`. The output is safe to assign to
 * `innerHTML`. On parse/sanitize failure we fall back to a text-only
 * escape so the user still sees the content.
 */
function renderMarkdown(md) {
  if (typeof md !== 'string' || md.length === 0) return ''
  try {
    const rawHtml = marked.parse(md)
    // Defence in depth: marked's TS type is `string | Promise<string>`.
    // We've pinned async:false above, but if that ever regresses we want
    // to land in the escaped-pre fallback rather than sanitize a stringified
    // Promise.
    if (typeof rawHtml !== 'string') throw new Error('marked returned non-string')
    return getPurifier().sanitize(rawHtml, { USE_PROFILES: { html: true } })
  } catch {
    // Escape & wrap in <pre> so a malformed parse surfaces as plain text
    // instead of silently blanking the message.
    const escaped = md.replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    )
    return `<pre>${escaped}</pre>`
  }
}

contextBridge.exposeInMainWorld('deck', {
  // ---- App / window state -------------------------------------------------
  getState: () => ipcRenderer.invoke('app:get-state'),
  onState: (cb) => {
    const listener = (_event, payload) => cb(payload)
    ipcRenderer.on('app:state', listener)
    return () => ipcRenderer.off('app:state', listener)
  },
  newWindow: () => ipcRenderer.invoke('app:new-window'),

  // ---- Deck lifecycle -----------------------------------------------------
  openDialog: () => ipcRenderer.invoke('app:open-dialog'),
  openPath: (p) => ipcRenderer.invoke('app:open-path', p),
  // Drop handler: webUtils.getPathForFile returns '' for non-fs drops;
  // main side silently ignores those.
  openDroppedFile: (file) => ipcRenderer.invoke('app:open-path', webUtils.getPathForFile(file)),
  newDeck: () => ipcRenderer.invoke('app:new-deck'),
  closeDeck: () => ipcRenderer.invoke('app:close-deck'),
  enterEditor: () => ipcRenderer.invoke('app:enter-editor'),
  enterPlayer: () => ipcRenderer.invoke('app:enter-player'),
  reloadPreview: () => ipcRenderer.invoke('app:reload-preview'),
  saveDeck: () => ipcRenderer.invoke('app:save-deck'),
  saveDeckAs: () => ipcRenderer.invoke('app:save-deck-as'),
  setPreviewBounds: (rect) => ipcRenderer.invoke('app:set-preview-bounds', rect),
  setDeckViewVisible: (visible) => ipcRenderer.invoke('app:set-deck-view-visible', visible),
  captureDeckView: () => ipcRenderer.invoke('app:capture-deck-view'),
  toggleFullScreen: () => ipcRenderer.invoke('app:toggle-fullscreen'),
  togglePresentation: () => ipcRenderer.invoke('app:toggle-presentation'),

  // ---- Recents ------------------------------------------------------------
  listRecents: () => ipcRenderer.invoke('app:list-recents'),
  forgetRecent: (p) => ipcRenderer.invoke('app:forget-recent', p),

  // ---- Chrome theme -------------------------------------------------------
  setChromeTheme: (theme) => ipcRenderer.invoke('app:set-chrome-theme', theme),

  // ---- AI chat ------------------------------------------------------------
  aiSend: (text) => ipcRenderer.invoke('ai:send', text),
  aiAbort: () => ipcRenderer.invoke('ai:abort'),
  aiReset: () => ipcRenderer.invoke('ai:reset'),

  // ---- Chat history switcher ----------------------------------------------
  chats: {
    list: () => ipcRenderer.invoke('chats:list'),
    switch: (sessionPath) => ipcRenderer.invoke('chats:switch', sessionPath),
    delete: (sessionPath) => ipcRenderer.invoke('chats:delete', sessionPath),
  },

  // ---- Attachments --------------------------------------------------------
  // Copy files the user dropped or pasted into the composer into the Deck
  // Source. Accepts a mix of `{kind:'path', path, mimeType?}` (drag-drop)
  // and `{kind:'bytes', fileName, mimeType, base64}` (clipboard paste).
  attachAssets: (inputs) => ipcRenderer.invoke('app:attach-assets', inputs),
  // Open an OS file picker for the Attach button. Returns
  //   { ok: boolean, files: { path, name, size, mimeType }[] }.
  pickAttachments: () => ipcRenderer.invoke('app:pick-attachments'),
  // Resolve a DataTransfer File to its on-disk path. Returns '' when the
  // drop wasn't backed by a filesystem entry (e.g. a drag from a browser).
  pathForDroppedFile: (file) => webUtils.getPathForFile(file),
  onAiEvent: (cb) => {
    const listener = (_event, payload) => cb(payload)
    ipcRenderer.on('ai:event', listener)
    return () => ipcRenderer.off('ai:event', listener)
  },

  // ---- Markdown + external links -----------------------------------------
  // Render Markdown (as emitted by the LLM) to sanitized HTML. Safe to
  // assign to innerHTML.
  renderMarkdown: (md) => renderMarkdown(md),
  // Open a URL in the user's default browser. Used by the chat pane's
  // click handler on links rendered from assistant Markdown. Guarded to
  // http/https/mailto so a malicious sanitizer bypass can't ship
  // arbitrary schemes (file://, javascript:, etc.) to the OS.
  openExternal: (url) => {
    if (typeof url !== 'string') return
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      // Not a well-formed absolute URL. Relative hrefs land here and are
      // silently dropped — AI markdown shouldn't emit them anyway.
      return
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'mailto:') return
    // shell.openExternal returns a Promise that rejects on OS failure;
    // fire-and-forget is fine for a chat link click.
    void shell.openExternal(url)
  },

  // Menu-triggered signal to open the settings overlay. One-shot push.
  onOpenSettings: (cb) => {
    const listener = () => cb()
    ipcRenderer.on('app:open-settings-overlay', listener)
    return () => ipcRenderer.off('app:open-settings-overlay', listener)
  },

  // ---- App menu (self-drawn, Win/Linux) -----------------------------------
  // The tree comes from main. Only Win/Linux renders a trigger in the
  // topbar; macOS hides it and defers to the OS menu bar. Changes land
  // through the onMenuTree push (e.g. when deck state flips Edit Deck
  // from disabled to enabled).
  menu: {
    get: () => ipcRenderer.invoke('app:menu-tree-get'),
    onChange: (cb) => {
      const listener = (_event, tree) => cb(tree)
      ipcRenderer.on('app:menu-tree', listener)
      return () => ipcRenderer.off('app:menu-tree', listener)
    },
    invoke: (id) => ipcRenderer.invoke('app:menu-invoke', id),
  },

  // ---- i18n ---------------------------------------------------------------
  i18n: {
    /** One-shot pull of { lang, pref, dict } at boot. */
    get: () => ipcRenderer.invoke('i18n:get'),
    /** Set the user preference: 'auto' | 'en' | 'zh' | 'ko'. */
    setPref: (pref) => ipcRenderer.invoke('i18n:set-pref', pref),
    /** Subscribe to language changes — receives { lang, pref, dict }. */
    onChange: (cb) => {
      const listener = (_event, payload) => cb(payload)
      ipcRenderer.on('app:i18n-changed', listener)
      return () => ipcRenderer.off('app:i18n-changed', listener)
    },
  },

  // ---- Settings overlay ---------------------------------------------------
  settings: {
    load: () => ipcRenderer.invoke('settings:load'),
    save: (patch) => ipcRenderer.invoke('settings:save', patch),
    listConfiguredProviders: () => ipcRenderer.invoke('settings:list-providers'),
    setApiKey: (provider, key) => ipcRenderer.invoke('settings:set-key', provider, key),
    clearApiKey: (provider) => ipcRenderer.invoke('settings:clear-key', provider),
    encryptionAvailable: () => ipcRenderer.invoke('settings:encryption-available'),
    ping: (overrides) => ipcRenderer.invoke('settings:ping', overrides),
    /** Returns { ready: boolean, reason?: string } — used to gate the
     *  composer Send button when the active provider isn't usable yet. */
    aiReadiness: () => ipcRenderer.invoke('settings:ai-readiness'),
  },
})
