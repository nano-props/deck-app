// Renders the "Recently opened" list on the upload screen. Pure view:
// reads via listRecents(), but mutations (delete, open) are delegated
// to callbacks supplied by the player so the player can sequence them
// against in-flight loads, history state, etc.

import { listRecents } from './cache.js'
import { icon } from './icons.js'
import { formatRelative } from './time-format.js'

/**
 * Render the recents list into `container`.
 *
 * @param {HTMLElement} container
 * @param {{onOpen: (deckId: string) => void,
 *          onDelete: (deckId: string) => void | Promise<void>}} callbacks
 */
export async function renderRecents(container, callbacks) {
  const items = await listRecents()
  if (items.length === 0) {
    container.replaceChildren()
    return
  }

  const heading = document.createElement('h2')
  heading.textContent = 'Recently opened'

  const ul = document.createElement('ul')
  for (const { id, name, ts } of items) {
    ul.append(buildRow(id, name, ts, callbacks))
  }

  container.replaceChildren(heading, ul)
}

function buildRow(id, name, ts, callbacks) {
  const li = document.createElement('li')

  // .open is the row's main button — block-level, so its intrinsic
  // height drives the li's height. .delete is absolutely positioned
  // over the right edge with a higher z-index.
  const open = document.createElement('button')
  open.type = 'button'
  open.className = 'open'
  open.title = 'Open ' + name
  open.append(makeNameSpan(name), makeTimeSpan(ts))
  open.addEventListener('click', () => callbacks.onOpen(id))

  const del = document.createElement('button')
  del.type = 'button'
  del.className = 'delete'
  del.setAttribute('aria-label', 'Remove ' + name)
  del.title = 'Remove from cache'
  del.append(icon.trash())
  del.addEventListener('click', (e) => {
    e.stopPropagation()
    // No confirm dialog — deletion is immediate but reversible from a
    // 5-second undo toast handled by the player. Passing the name
    // along lets the toast quote it.
    callbacks.onDelete(id, name)
  })

  li.append(open, del)
  return li
}

function makeNameSpan(name) {
  const el = document.createElement('span')
  el.className = 'name'
  el.textContent = name
  return el
}

function makeTimeSpan(ts) {
  const el = document.createElement('span')
  el.className = 'time'
  el.textContent = formatRelative(ts)
  return el
}
