import { state } from './state.js'

// Composer attachments — files dropped onto the composer or pasted via
// Cmd/Ctrl+V render as chips above the textarea. On send, valid chips
// are copied into the Deck Source's assets/ by main and the resolved
// relative paths are returned for inclusion in the agent's prompt.
//
// Bytes never traverse the LLM — see src/main/attachments.ts.
//
// Public API consumed by chat.js:
//   - `hasValid()` / `hasAny()`     — send-button gating
//   - `flush()`                     — called from `sendMessage`; persists
//                                     valid chips and returns the prompt
//                                     prefix + main-side rejections
//   - `clearAll()`                  — on session_reset
//
// Everything else is internal.

const attachmentsEl = document.getElementById('attachments')
const composerEl = document.getElementById('composer')
const input = document.getElementById('input')

// In-memory staging. Each chip owns a transient renderer-side record.
// `source` is EITHER a File (drag) — resolved via preload `pathForDroppedFile`
// when submitting — OR a Blob (paste) — read as base64 for the bytes path.
const pendingAttachments = []
let nextAttachmentId = 1

// Pre-flight rules. Kept in sync with src/main/attachments.ts so the user
// gets an immediate reject chip on drop/paste instead of learning at Send
// time. If the two drift, main is still the source of truth — renderer
// just shortcuts the obvious cases.
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024
const ALLOWED_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.avif',
  '.mp4',
  '.webm',
  '.mov',
  '.m4v',
  '.mp3',
  '.wav',
  '.ogg',
  '.m4a',
  '.flac',
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  '.vtt',
  '.srt',
])
const REJECTED_EXT = new Set(['.html', '.htm', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.json'])
const ALLOWED_MIME_PREFIX = ['image/', 'video/', 'audio/', 'font/']

function extOf(name) {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot).toLowerCase() : ''
}

function preflightReject(file) {
  const name = file.name || ''
  const mime = file.type || ''
  const ext = extOf(name)
  if (REJECTED_EXT.has(ext)) {
    return `${ext} is source code — paste the text or ask the AI to write it.`
  }
  if (Number.isFinite(file.size) && file.size > MAX_ATTACHMENT_BYTES) {
    return `Over ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB limit.`
  }
  if (ALLOWED_EXT.has(ext)) return null
  if (ALLOWED_MIME_PREFIX.some((p) => mime.startsWith(p))) return null
  return `Unsupported file type (${mime || ext || 'unknown'}).`
}

function humanBytes(n) {
  if (!Number.isFinite(n)) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

function fileKindLabel(mimeType, name) {
  if (mimeType?.startsWith('image/')) return 'image'
  if (mimeType?.startsWith('video/')) return 'video'
  if (mimeType?.startsWith('audio/')) return 'audio'
  if (mimeType?.startsWith('font/') || /\.(ttf|otf|woff2?|eot)$/i.test(name || '')) return 'font'
  return 'file'
}

function iconForKind(kind) {
  // Inline SVG so we don't carry a sprite sheet just for a handful of glyphs.
  const stroke = 'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
  if (kind === 'video') {
    return `<svg class="icon" viewBox="0 0 24 24" fill="none" ${stroke}><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/></svg>`
  }
  if (kind === 'audio') {
    return `<svg class="icon" viewBox="0 0 24 24" fill="none" ${stroke}><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`
  }
  if (kind === 'font') {
    return `<svg class="icon" viewBox="0 0 24 24" fill="none" ${stroke}><path d="M4 7V5h16v2"/><path d="M9 19h6"/><path d="M12 5v14"/></svg>`
  }
  // generic file
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" ${stroke}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`
}

function renderAttachmentsRow() {
  attachmentsEl.innerHTML = ''
  if (pendingAttachments.length === 0) {
    attachmentsEl.hidden = true
    return
  }
  attachmentsEl.hidden = false
  for (const att of pendingAttachments) {
    const wrap = document.createElement('div')
    wrap.className = 'attachment'
    if (att.error) wrap.classList.add('error')

    const thumb = document.createElement('span')
    thumb.className = 'thumb'
    if (att.previewUrl) {
      const img = document.createElement('img')
      img.src = att.previewUrl
      img.alt = ''
      thumb.appendChild(img)
    } else {
      thumb.innerHTML = iconForKind(fileKindLabel(att.mimeType, att.name))
    }

    const meta = document.createElement('span')
    meta.className = 'meta'
    const filename = document.createElement('span')
    filename.className = 'filename'
    filename.textContent = att.name
    const subline = document.createElement('span')
    subline.className = 'subline'
    subline.textContent = att.error ? att.error : `${fileKindLabel(att.mimeType, att.name)} · ${humanBytes(att.size)}`
    meta.append(filename, subline)

    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'remove'
    remove.title = 'Remove'
    remove.setAttribute('aria-label', `Remove ${att.name}`)
    remove.innerHTML =
      '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>'
    remove.addEventListener('click', () => {
      const i = pendingAttachments.indexOf(att)
      if (i >= 0) {
        if (att.previewUrl) URL.revokeObjectURL(att.previewUrl)
        pendingAttachments.splice(i, 1)
        renderAttachmentsRow()
      }
    })

    wrap.append(thumb, meta, remove)
    attachmentsEl.appendChild(wrap)
  }
}

function addAttachmentFromFile(file) {
  // `webUtils.getPathForFile(file)` returns '' if the File isn't backed by
  // a filesystem path — happens for some cross-origin drags and every
  // paste-from-clipboard case. We branch on that.
  const fsPath = window.deck.pathForDroppedFile?.(file) || ''
  const error = preflightReject(file)
  // Only generate a preview URL for accepted images — rejected chips don't
  // need a bitmap blob sitting in memory until the user removes them.
  const previewUrl = !error && file.type?.startsWith('image/') ? URL.createObjectURL(file) : ''
  pendingAttachments.push({
    id: nextAttachmentId++,
    name: file.name || 'pasted-file',
    size: file.size,
    mimeType: file.type || '',
    source: fsPath ? { kind: 'path', path: fsPath } : { kind: 'blob', blob: file },
    previewUrl,
    error,
  })
  renderAttachmentsRow()
}

/** Drop handling scoped to the composer. Window-level dragover still runs
 *  (to suppress the default navigate-to-file behavior), but we mark the
 *  composer visually and do the actual work here. */
;['dragenter', 'dragover'].forEach((evt) => {
  composerEl.addEventListener(evt, (e) => {
    if (state.mode !== 'deck' || state.subView !== 'edit') return
    if (!e.dataTransfer?.types?.includes('Files')) return
    e.preventDefault()
    e.stopPropagation()
    composerEl.classList.add('drag')
  })
})
composerEl.addEventListener('dragleave', (e) => {
  // Only clear when the cursor has actually left the composer box — not on
  // every child-to-child transition.
  const rect = composerEl.getBoundingClientRect()
  if (e.clientX <= rect.left || e.clientX >= rect.right || e.clientY <= rect.top || e.clientY >= rect.bottom) {
    composerEl.classList.remove('drag')
  }
})
composerEl.addEventListener('drop', (e) => {
  if (state.mode !== 'deck' || state.subView !== 'edit') return
  const files = Array.from(e.dataTransfer?.files || [])
  if (files.length === 0) return
  e.preventDefault()
  e.stopPropagation()
  composerEl.classList.remove('drag')
  for (const f of files) addAttachmentFromFile(f)
})

/** Cmd/Ctrl+V paste: pull image blobs out of the clipboard and stage them.
 *  Plain text paste is left to the textarea's native behavior. */
input.addEventListener('paste', (e) => {
  if (state.mode !== 'deck' || state.subView !== 'edit') return
  const items = e.clipboardData?.items
  if (!items) return
  const staged = []
  for (const item of items) {
    if (item.kind === 'file') {
      const file = item.getAsFile()
      if (file) staged.push(file)
    }
  }
  if (staged.length === 0) return
  // We found files — suppress the default so the textarea doesn't also
  // receive garbage (some paste sources put a filename string alongside).
  e.preventDefault()
  for (const f of staged) addAttachmentFromFile(f)
})

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result || ''
      // result is a data URL `data:<mime>;base64,<payload>`; strip prefix.
      const comma = typeof result === 'string' ? result.indexOf(',') : -1
      resolve(comma >= 0 ? result.slice(comma + 1) : '')
    }
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
    reader.readAsDataURL(blob)
  })
}

/** True if at least one chip is attached and not already error-flagged. */
export function hasValid() {
  return pendingAttachments.some((a) => !a.error)
}

/** True if anything is staged — including pre-flight-rejected chips, used
 *  to decide whether Send should nudge the user ("remove invalid first"). */
export function hasAny() {
  return pendingAttachments.length > 0
}

/**
 * Convert the valid staged chips into the IPC shape main expects, invoke
 * attachAssets, and return an `<attached_files>` block ready to prepend to
 * the agent's user message.
 *
 * Chips that failed pre-flight (`att.error`) are NOT sent to main — they
 * stay in `pendingAttachments` so the user can see the red chip and remove
 * it. If main surfaces its own rejection for a file that passed pre-flight
 * (race, rare), we surface it the same way by reinstating the chip.
 */
export async function flush() {
  const valid = pendingAttachments.filter((att) => !att.error)
  if (valid.length === 0) return { block: '', rejected: [] }

  const inputs = []
  for (const att of valid) {
    if (att.source.kind === 'path') {
      inputs.push({ kind: 'path', path: att.source.path, mimeType: att.mimeType })
    } else {
      const base64 = await blobToBase64(att.source.blob)
      inputs.push({ kind: 'bytes', fileName: att.name, mimeType: att.mimeType || 'application/octet-stream', base64 })
    }
  }
  const res = await window.deck.attachAssets(inputs)
  if (!res?.ok) {
    throw new Error(res?.error || 'Failed to attach files')
  }

  // Only drop the chips we successfully sent. Pre-flight-rejected chips
  // remain; any main-side rejections are flipped to `error` state on the
  // matching chip so the user sees what went wrong without the chip
  // disappearing out from under them.
  const mainRejected = new Map()
  for (const r of res.rejected ?? []) mainRejected.set(r.name, r.reason)

  const survivors = []
  for (const att of pendingAttachments) {
    if (att.error) {
      // Pre-flight reject — keep the red chip.
      survivors.push(att)
      continue
    }
    const mainReason = mainRejected.get(att.name)
    if (mainReason) {
      // Flip to error state; the user can now see and dismiss it.
      if (att.previewUrl) {
        URL.revokeObjectURL(att.previewUrl)
        att.previewUrl = ''
      }
      att.error = mainReason
      survivors.push(att)
      continue
    }
    // Accepted — drop the chip.
    if (att.previewUrl) URL.revokeObjectURL(att.previewUrl)
  }
  pendingAttachments.length = 0
  pendingAttachments.push(...survivors)
  renderAttachmentsRow()

  const lines = []
  if (res.staged.length > 0) {
    lines.push('<attached_files>')
    for (const s of res.staged) {
      lines.push(`- ${s.relPath} (${s.mimeType}, ${humanBytes(s.bytes)})`)
    }
    lines.push('</attached_files>')
  }
  return { block: lines.join('\n'), rejected: res.rejected ?? [] }
}

/** Drop all chips (valid and rejected). Called on `session_reset`. */
export function clearAll() {
  for (const att of pendingAttachments) {
    if (att.previewUrl) URL.revokeObjectURL(att.previewUrl)
  }
  pendingAttachments.length = 0
  renderAttachmentsRow()
}
