// Command palette: a focused overlay over the stage that exposes the
// player's container-level actions (back, switch deck, future
// extensions). Triggered by Cmd/Ctrl+K or "?", closed by Esc / outside
// click. Pure view module: callbacks come from the player.

import { listRecents } from './cache.js'
import { icon } from './icons.js'
import { formatRelative } from './time-format.js'

export class Palette {
  /**
   * @param {{
   *   root: HTMLElement,        // #palette
   *   body: HTMLElement,        // #palette-body
   *   onBack: () => void,
   *   onOpenDeck: (deckId: string) => void,
   * }} opts
   */
  constructor(opts) {
    this.root = opts.root
    this.body = opts.body
    this.onBack = opts.onBack
    this.onOpenDeck = opts.onOpenDeck
    this.items = []        // [{ activate: () => void, el: HTMLElement }]
    this.activeIndex = 0
    this.previouslyFocused = null
    // Bumped on every open(); async recents render compares against
    // this so a stale render can't append items into the next session.
    this.openGen = 0

    // Backdrop click closes; clicks on the panel itself don't.
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.close()
    })
  }

  get isOpen() { return this.root.classList.contains('active') }

  open() {
    if (this.isOpen) return
    this.previouslyFocused = document.activeElement

    // Render the action group SYNCHRONOUSLY so the palette appears with
    // content on the same frame. The recents list (which requires async
    // Cache API lookups) streams in afterward — without this the user
    // sees several dozen ms of empty palette while listRecents resolves.
    this.renderActions()

    this.root.classList.add('active')
    this.setActive(0)
    // Move focus into the dialog so Esc/arrow keys are received here
    // rather than by the iframe behind the overlay.
    this.root.focus()

    // Capture the open generation so a slow recents render that
    // resolves after the user has closed and re-opened doesn't pollute
    // the next session's DOM.
    const gen = ++this.openGen
    this.renderRecents(gen).catch((err) => console.error(err))
  }

  close() {
    if (!this.isOpen) return
    this.root.classList.remove('active')
    if (this.previouslyFocused && this.previouslyFocused.focus) {
      try { this.previouslyFocused.focus() } catch (_e) {}
    }
    this.previouslyFocused = null
  }

  toggle() { this.isOpen ? this.close() : this.open() }

  // Synchronous: build the always-present actions group. Called every
  // open() so item closures capture the current callbacks.
  renderActions() {
    this.items = []
    this.body.replaceChildren()

    const actions = group('Actions')
    actions.append(this.makeItem({
      icon: icon.back(),
      label: 'Back to library',
      meta: 'Esc',
      activate: () => { this.close(); this.onBack() },
    }))
    this.body.append(actions)
  }

  // Asynchronous: append the recents group once Cache API has resolved.
  async renderRecents(gen) {
    const recents = await listRecents()
    // The user might have closed and re-opened the palette while we
    // were awaiting. Bail if our snapshot is stale.
    if (gen !== this.openGen || !this.isOpen) return
    if (recents.length === 0) return

    const g = group('Switch deck')
    for (const { id, name, ts } of recents) {
      g.append(this.makeItem({
        icon: icon.deck(),
        label: name,
        meta: formatRelative(ts),
        activate: () => { this.close(); this.onOpenDeck(id) },
      }))
    }
    this.body.append(g)
  }

  makeItem({ icon, label, meta, activate }) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'item'
    btn.setAttribute('role', 'option')

    const iconEl = document.createElement('span')
    iconEl.className = 'icon'
    iconEl.append(icon)

    const labelEl = document.createElement('span')
    labelEl.className = 'label'
    labelEl.textContent = label

    const metaEl = document.createElement('span')
    metaEl.className = 'meta'
    metaEl.textContent = meta || ''

    btn.append(iconEl, labelEl, metaEl)
    btn.addEventListener('click', activate)
    btn.addEventListener('mousemove', () => {
      // Keyboard arrow navigation drives `.active`; mouse move syncs
      // it so the keyboard cursor follows the pointer. Skip the work
      // when this row is already active — mousemove fires every frame
      // while the cursor is moving, but the state only flips at row
      // boundaries.
      const idx = this.items.findIndex((it) => it.el === btn)
      if (idx >= 0 && idx !== this.activeIndex) this.setActive(idx)
    })

    this.items.push({ el: btn, activate })
    return btn
  }

  setActive(idx) {
    if (this.items.length === 0) return
    const wrapped = ((idx % this.items.length) + this.items.length) % this.items.length
    this.items.forEach((it, i) => it.el.classList.toggle('active', i === wrapped))
    this.activeIndex = wrapped
    // Scroll into view if needed.
    const el = this.items[wrapped].el
    if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest' })
  }

  /**
   * Forward a keyboard event from the document. Returns true if the
   * palette consumed the event (caller should preventDefault).
   */
  handleKey(e) {
    if (!this.isOpen) return false
    if (e.key === 'Escape') { this.close(); return true }
    if (e.key === 'ArrowDown') { this.setActive(this.activeIndex + 1); return true }
    if (e.key === 'ArrowUp') { this.setActive(this.activeIndex - 1); return true }
    if (e.key === 'Home') { this.setActive(0); return true }
    if (e.key === 'End') { this.setActive(this.items.length - 1); return true }
    if (e.key === 'Enter') {
      const item = this.items[this.activeIndex]
      if (item) item.activate()
      return true
    }
    // Focus trap: keep Tab inside the palette so the user can't tab
    // back to elements behind the modal overlay (and into the iframe,
    // where keys would no longer reach this listener).
    if (e.key === 'Tab') {
      if (this.items.length === 0) return true
      const next = e.shiftKey
        ? (this.activeIndex - 1 + this.items.length) % this.items.length
        : (this.activeIndex + 1) % this.items.length
      this.setActive(next)
      return true
    }
    return false
  }
}

function group(label) {
  const g = document.createElement('div')
  g.className = 'group'
  if (label) {
    const h = document.createElement('div')
    h.className = 'group-label'
    h.textContent = label
    g.append(h)
  }
  return g
}
