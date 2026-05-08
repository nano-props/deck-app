// Composer attachments — chips staged before send. Add via:
//   - drag & drop onto the composer
//   - Cmd/Ctrl+V paste of a file blob
//   - the Attach button → OS file picker
//
// Each chip carries enough info to render and to ship to main on send:
//   - `source` is either { kind: 'path' } (filesystem) or { kind: 'blob' }
//     (clipboard paste). main turns these into `attach-assets` IPC inputs.
//   - `error` short-circuits send-time persistence; rejected chips show
//     in red and the user has to remove them.

import { create } from 'zustand'

export interface Attachment {
  id: number
  name: string
  size: number
  mimeType: string
  source: { kind: 'path'; path: string } | { kind: 'blob'; blob: Blob }
  /** Object URL for image previews, '' otherwise. Revoked on remove/clear. */
  previewUrl: string
  /** Localized error string when the chip failed pre-flight. */
  error: string | null
}

interface AttachmentStore {
  items: Attachment[]
  /** True if at least one chip is attached and not error-flagged. */
  hasValid: () => boolean
  /** True if anything is staged — including pre-flight-rejected. */
  hasAny: () => boolean

  add: (att: Omit<Attachment, 'id'>) => void
  remove: (id: number) => void
  /** Drop everything. Called on session reset and after a successful send. */
  clearAll: () => void
  /** Drop only the chips matching `ids`. Used after send: chips that
   *  passed main-side validation are removed; rejected ones stay flipped
   *  to red until the user dismisses them. */
  removeMany: (ids: number[]) => void
  /** Mark a chip as failed (server-side rejection). Revokes its
   *  previewUrl so the broken image isn't held in memory. */
  setError: (id: number, error: string) => void
}

let nextId = 1

export const useAttachments = create<AttachmentStore>((set, get) => ({
  items: [],
  hasValid: () => get().items.some((a) => !a.error),
  hasAny: () => get().items.length > 0,
  add: (att) => set((s) => ({ items: [...s.items, { ...att, id: nextId++ }] })),
  remove: (id) =>
    set((s) => {
      const removed = s.items.find((a) => a.id === id)
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl)
      return { items: s.items.filter((a) => a.id !== id) }
    }),
  clearAll: () =>
    set((s) => {
      for (const a of s.items) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl)
      return { items: [] }
    }),
  removeMany: (ids) =>
    set((s) => {
      const drop = new Set(ids)
      for (const a of s.items) {
        if (drop.has(a.id) && a.previewUrl) URL.revokeObjectURL(a.previewUrl)
      }
      return { items: s.items.filter((a) => !drop.has(a.id)) }
    }),
  setError: (id, error) =>
    set((s) => ({
      items: s.items.map((a) => {
        if (a.id !== id) return a
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl)
        return { ...a, error, previewUrl: '' }
      }),
    })),
}))
