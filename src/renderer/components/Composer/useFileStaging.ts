import { useState } from 'react'
import { useAttachments } from '#/renderer/stores/attachments.ts'
import { useI18n } from '#/renderer/stores/i18n.ts'
import { extOf, preflightReject } from '#/renderer/components/Composer/attachment-utils.ts'
import { looksLikeCode } from '#/renderer/components/Composer/format.ts'

/**
 * Drag/drop, paste, and pick orchestration for the Composer textarea.
 * Owns the drop overlay state and the "wrap in fence" suggestion range.
 */
export function useFileStaging(): {
  composerDrag: boolean
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  onPaste: (e: React.ClipboardEvent) => void
  lastPasteRange: { start: number; end: number } | null
  setLastPasteRange: (r: { start: number; end: number } | null) => void
  pickFiles: () => Promise<void>
  addFromFile: (file: File) => void
} {
  const t = useI18n((s) => s.t)
  const attachments = useAttachments()
  const [composerDrag, setComposerDrag] = useState(false)
  const [lastPasteRange, setLastPasteRange] = useState<{ start: number; end: number } | null>(null)

  function addFromFile(file: File) {
    const fsPath = window.deck.pathForDroppedFile?.(file) ?? ''
    const ext = (file.name.match(/\.[^.]+$/)?.[0] ?? '').toLowerCase()
    const error = preflightReject(file, ext, t)
    const previewUrl = !error && file.type?.startsWith('image/') ? URL.createObjectURL(file) : ''
    attachments.add({
      name: file.name,
      size: file.size,
      mimeType: file.type ?? '',
      source: fsPath ? { kind: 'path', path: fsPath } : { kind: 'blob', blob: file },
      previewUrl,
      error,
    })
  }

  function onDragOver(e: React.DragEvent) {
    if (!e.dataTransfer?.types?.includes('Files')) return
    e.preventDefault()
    e.stopPropagation()
    setComposerDrag(true)
  }
  function onDragLeave(e: React.DragEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    if (e.clientX <= r.left || e.clientX >= r.right || e.clientY <= r.top || e.clientY >= r.bottom) {
      setComposerDrag(false)
    }
  }
  function onDrop(e: React.DragEvent) {
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (files.length === 0) return
    e.preventDefault()
    e.stopPropagation()
    setComposerDrag(false)
    for (const f of files) addFromFile(f)
  }

  function onPaste(e: React.ClipboardEvent) {
    const items = e.clipboardData?.items
    if (!items) return
    const staged: File[] = []
    for (const item of items) {
      if (item.kind === 'file') {
        const f = item.getAsFile()
        if (f) staged.push(f)
      }
    }
    if (staged.length > 0) {
      e.preventDefault()
      for (const f of staged) addFromFile(f)
      return
    }
    // Text paste — let the browser do the actual insert (preserves
    // undo / cursor behavior), but record the range so we can offer a
    // "wrap in code fence" affordance if the chunk looks like code.
    const pastedText = e.clipboardData.getData('text/plain') ?? ''
    if (!pastedText) return
    const ta = e.currentTarget as HTMLTextAreaElement
    const start = ta.selectionStart
    if (looksLikeCode(pastedText)) {
      setLastPasteRange({ start, end: start + pastedText.length })
    } else {
      setLastPasteRange(null)
    }
  }

  async function pickFiles() {
    const r = await window.deck.pickAttachments?.()
    if (!r?.ok || !r.files?.length) return
    for (const meta of r.files) {
      attachments.add({
        name: meta.name,
        size: meta.size,
        mimeType: meta.mimeType,
        source: { kind: 'path', path: meta.path },
        previewUrl: '',
        error: preflightReject({ name: meta.name, size: meta.size, type: meta.mimeType } as File, extOf(meta.name), t),
      })
    }
  }

  return {
    composerDrag,
    onDragOver,
    onDragLeave,
    onDrop,
    onPaste,
    lastPasteRange,
    setLastPasteRange,
    pickFiles,
    addFromFile,
  }
}
