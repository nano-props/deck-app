import { useI18n } from '#/renderer/stores/i18n.ts'

const MAX_BYTES = 100 * 1024 * 1024

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

type Translate = ReturnType<typeof useI18n.getState>['t']

export function extOf(name: string): string {
  // Skip a leading dot so dotfiles like `.gitignore` report ext='' (not
  // `.gitignore`) — otherwise `extOf` would treat the whole filename as
  // an extension and produce confusing reject messages.
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return ''
  return name.slice(dot).toLowerCase()
}

export function kindToken(mime: string, name: string): 'image' | 'video' | 'audio' | 'font' | 'file' {
  if (mime?.startsWith('image/')) return 'image'
  if (mime?.startsWith('video/')) return 'video'
  if (mime?.startsWith('audio/')) return 'audio'
  if (mime?.startsWith('font/') || /\.(ttf|otf|woff2?|eot)$/i.test(name || '')) return 'font'
  return 'file'
}

export function kindLabel(mime: string, name: string, t: Translate): string {
  return t(`attach.kind.${kindToken(mime, name)}` as any)
}

/**
 * Read a Blob as base64 without blocking the main thread.
 *
 * The previous implementation walked `Uint8Array` byte-by-byte to build
 * a binary string, then ran `btoa` over it — both synchronous, both
 * O(n) on the main thread. A 20MB clipboard screenshot froze the UI for
 * roughly a second; a 100MB drop (the renderer-side hard cap) for ~6s.
 *
 * `FileReader.readAsDataURL` runs the encode off-thread (Chromium ships
 * a worker-backed implementation) so the renderer stays responsive.
 * The dataURL prefix `data:<mime>;base64,` is stripped by splitting on
 * the first comma; everything after is the base64 payload main expects.
 */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error('FileReader returned non-string result'))
        return
      }
      const comma = result.indexOf(',')
      // dataURL is always `data:<mime>;base64,<payload>` for readAsDataURL.
      // The early-bail just keeps us robust against a misconfigured reader.
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
    reader.readAsDataURL(blob)
  })
}

export function preflightReject(file: File, ext: string, t: Translate): string | null {
  const mime = file.type ?? ''
  if (REJECTED_EXT.has(ext)) return t('attach.reject.sourceCode', { ext })
  if (Number.isFinite(file.size) && file.size > MAX_BYTES) {
    return t('attach.reject.tooLarge', { mb: Math.round(MAX_BYTES / 1024 / 1024) })
  }
  if (ALLOWED_EXT.has(ext)) return null
  if (ALLOWED_MIME_PREFIX.some((p) => mime.startsWith(p))) return null
  return t('attach.reject.unsupported', { label: mime || ext || t('attach.reject.unknown') })
}
