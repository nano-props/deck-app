// Self-drawn application menu.
//
// On macOS the OS menu bar is the source of truth; the trigger button is
// hidden via CSS (html[data-chrome='overlay'] gates it). On Win/Linux
// this renders a VS Code-style "≡" in the topbar left. Clicking opens a
// panel with the top-level menus (File / Edit / View) as tabs; hovering
// or clicking a tab swaps the visible submenu.
//
// The tree comes from main (see src/main/menu.ts::buildMenuTree) and is
// re-pushed whenever `enabled` values could have changed. Accelerators
// are rendered to a platform-friendly display form (⇧⌘E on mac, though
// mac normally doesn't use this UI).

const IS_MAC = /Mac/i.test(navigator.platform)

const trigger = document.getElementById('appMenuTrigger')
const panel = document.getElementById('appMenu')

// On macOS the OS menu bar is the UI; the trigger is hidden via CSS
// (html[data-chrome='overlay'] gates it) and the self-drawn menu never
// opens. Bail early so mac doesn't pay for listeners, DOM rebuilds, or
// an IPC round-trip fetching a tree it never shows. We can't check
// `data-chrome` here — this ESM module runs deferred BEFORE
// DOMContentLoaded, and `app-preload.js` sets the attribute in its own
// DOMContentLoaded listener — so key off `navigator.platform` directly.

/** @type {import('../../main/menu.ts').MenuNode[]} */
let tree = []
/** Index of the currently-open top-level submenu, or -1 if the panel is
 *  closed. The panel itself stays mounted but `hidden` when closed. */
let openIndex = -1

// ---------------------------------------------------------------------------
// Accelerator display
// ---------------------------------------------------------------------------

/**
 * Map an Electron accelerator string ("CmdOrCtrl+Shift+E") to a form
 * suitable for the menu's right column. macOS uses the familiar glyphs
 * (⌘⇧⌥⌃); other platforms spell them out. Unknown tokens pass through.
 */
function formatAccelerator(acc) {
  if (!acc) return ''
  return acc
    .split('+')
    .map((part) => {
      const key = part.trim()
      if (IS_MAC) {
        if (key === 'CmdOrCtrl' || key === 'Cmd' || key === 'Command') return '⌘'
        if (key === 'Shift') return '⇧'
        if (key === 'Alt' || key === 'Option') return '⌥'
        if (key === 'Ctrl' || key === 'Control') return '⌃'
        if (key === 'Plus') return '+'
        return key
      }
      if (key === 'CmdOrCtrl' || key === 'Cmd' || key === 'Command') return 'Ctrl'
      if (key === 'Plus') return '+'
      return key
    })
    .join(IS_MAC ? '' : '+')
}

// ---------------------------------------------------------------------------
// Open / close
// ---------------------------------------------------------------------------

function open(index) {
  if (!tree.length) return
  const clamped = Math.max(0, Math.min(index, tree.length - 1))
  openIndex = clamped
  panel.hidden = false
  trigger.setAttribute('aria-expanded', 'true')
  positionPanel()
  render()
}

function close() {
  if (openIndex === -1 && panel.hidden) return
  openIndex = -1
  panel.hidden = true
  trigger.setAttribute('aria-expanded', 'false')
  // Keep focus where the user left it unless the trigger was the last
  // interactive element. Don't steal focus from inputs in the chat pane.
  if (document.activeElement && panel.contains(document.activeElement)) {
    trigger.focus()
  }
}

function toggle() {
  if (openIndex === -1) open(0)
  else close()
}

// ---------------------------------------------------------------------------
// Position
// ---------------------------------------------------------------------------

/** Pin the panel's top-left to the trigger's bottom-left, with a small
 *  gap. Fixed positioning so window scrolls don't matter. Re-run on
 *  window resize while open. */
function positionPanel() {
  const rect = trigger.getBoundingClientRect()
  panel.style.top = `${rect.bottom + 4}px`
  panel.style.left = `${rect.left}px`
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render() {
  panel.innerHTML = ''

  // Header: one tab per top-level submenu.
  const header = document.createElement('div')
  header.className = 'app-menu-header'
  tree.forEach((node, i) => {
    if (node.kind !== 'submenu') return
    const tab = document.createElement('button')
    tab.type = 'button'
    tab.className = 'app-menu-tab'
    tab.textContent = node.label
    tab.dataset.index = String(i)
    if (i === openIndex) tab.classList.add('active')
    tab.addEventListener('mouseenter', () => {
      if (openIndex !== i) {
        openIndex = i
        render()
      }
    })
    tab.addEventListener('click', () => {
      openIndex = i
      render()
    })
    header.appendChild(tab)
  })
  panel.appendChild(header)

  // Body: the currently-open submenu's items.
  const submenu = tree[openIndex]
  if (!submenu || submenu.kind !== 'submenu') return

  const list = document.createElement('div')
  list.className = 'app-menu-list'
  submenu.items.forEach((item) => {
    if (item.kind === 'separator') {
      const hr = document.createElement('div')
      hr.className = 'app-menu-sep'
      hr.setAttribute('role', 'separator')
      list.appendChild(hr)
      return
    }
    if (item.kind === 'submenu') {
      // Nested submenus aren't used today. If they appear later, this
      // renders them as flat headers with their items inline rather
      // than silently dropping them.
      const heading = document.createElement('div')
      heading.className = 'app-menu-heading'
      heading.textContent = item.label
      list.appendChild(heading)
      return
    }
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'app-menu-item'
    row.setAttribute('role', 'menuitem')
    row.dataset.id = item.id
    if (!item.enabled) row.setAttribute('disabled', '')

    const label = document.createElement('span')
    label.className = 'app-menu-label'
    label.textContent = item.label
    row.appendChild(label)

    const acc = formatAccelerator(item.accelerator)
    if (acc) {
      const kbd = document.createElement('span')
      kbd.className = 'app-menu-accel'
      kbd.textContent = acc
      row.appendChild(kbd)
    }

    row.addEventListener('click', () => {
      if (!item.enabled) return
      close()
      window.deck.menu.invoke(item.id)
    })
    list.appendChild(row)
  })
  panel.appendChild(list)
}

// ---------------------------------------------------------------------------
// Global listeners
// ---------------------------------------------------------------------------

trigger.addEventListener('click', (event) => {
  event.stopPropagation()
  toggle()
})

// Click-outside closes. Use `mousedown` (not click) so the close happens
// before the downstream click fires on whatever the user was aiming at —
// matches OS menu behavior where clicking elsewhere dismisses the menu
// and routes the click to that target.
document.addEventListener('mousedown', (event) => {
  if (openIndex === -1) return
  if (panel.contains(event.target) || trigger.contains(event.target)) return
  close()
})

// Keyboard: left/right switches top-level, up/down moves within submenu,
// Enter triggers, Escape closes. Only active while the panel is open.
document.addEventListener('keydown', (event) => {
  if (openIndex === -1) return
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
    return
  }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault()
    const dir = event.key === 'ArrowLeft' ? -1 : 1
    let next = openIndex + dir
    if (next < 0) next = tree.length - 1
    if (next >= tree.length) next = 0
    openIndex = next
    render()
    return
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const items = Array.from(panel.querySelectorAll('.app-menu-item:not([disabled])'))
    if (!items.length) return
    const active = document.activeElement
    const currentIndex = items.indexOf(active)
    const dir = event.key === 'ArrowDown' ? 1 : -1
    let next = currentIndex + dir
    if (next < 0) next = items.length - 1
    if (next >= items.length) next = 0
    items[next].focus()
    return
  }
  // Enter / Space on a focused menu item: let the browser fire the
  // button's native click — our `click` listener handles close + invoke.
  // We only preventDefault for Space, to stop the viewport from scrolling
  // while a menu-item button has focus.
  if (event.key === ' ') {
    const active = document.activeElement
    if (active && active.classList.contains('app-menu-item')) event.preventDefault()
  }
})

window.addEventListener('resize', () => {
  if (openIndex !== -1) positionPanel()
})

// ---------------------------------------------------------------------------
// Tree wiring
// ---------------------------------------------------------------------------

if (!IS_MAC) {
  window.deck.menu.onChange((next) => {
    tree = Array.isArray(next) ? next : []
    if (openIndex !== -1) render()
  })
  ;(async () => {
    const initial = await window.deck.menu.get()
    tree = Array.isArray(initial) ? initial : []
  })()
}
