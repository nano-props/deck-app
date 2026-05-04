import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * Accept files dropped or pasted into the chat composer and copy them into
 * the Deck Source's `assets/` directory. This is the cheap path — the bytes
 * never traverse the LLM. The agent gets a text prefix listing the final
 * relative paths, and references them from its generated HTML/CSS.
 *
 * Compare to `add_asset` in src/main/ai/tools.ts: that tool still exists for
 * the agent-driven path (e.g. "write me a favicon" → agent synthesizes bytes
 * and calls add_asset), but for *user-supplied* attachments it would waste
 * tokens base64-ing binaries through the context window.
 */

// File-type gate. We accept obvious deck-ready resource types and reject
// source-code shapes that the AI should be authoring itself.
const ALLOWED_MIME_PREFIX = ['image/', 'video/', 'audio/', 'font/']
const ALLOWED_EXT = new Set([
  // images
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.avif',
  // video
  '.mp4',
  '.webm',
  '.mov',
  '.m4v',
  // audio
  '.mp3',
  '.wav',
  '.ogg',
  '.m4a',
  '.flac',
  // fonts
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  // captions / subtitles — worth allowing since they're the usual companions
  // to <video>/<track>.
  '.vtt',
  '.srt',
])
// Never accept these as "attachments" — they're code, not assets. If the
// user wants AI to edit code, paste the text; don't drop the file.
const REJECTED_EXT = new Set(['.html', '.htm', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.json'])

/** Single-file hard cap. Decks are meant to be self-contained and shippable. */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024 // 100 MB

/**
 * Renderer → main payload. Either a filesystem path (from a file drag) or
 * raw bytes as base64 (from a clipboard paste of an in-memory blob).
 *
 * We take base64 over raw Buffer because electron IPC serializes Buffers as
 * Uint8Array but TS types through contextBridge drift; base64 is boring and
 * round-trips through the preload without surprises for a few-MB screenshot.
 */
export type StagedInput =
  | {
      kind: 'path'
      /** Absolute filesystem path from `webUtils.getPathForFile(file)`. */
      path: string
      /** Browser-reported MIME, used as a hint when the extension is weak. */
      mimeType?: string
    }
  | {
      kind: 'bytes'
      /** Suggested filename — e.g. `screenshot.png` for pasted screenshots. */
      fileName: string
      mimeType: string
      /** Base64-encoded bytes (no `data:` prefix). */
      base64: string
    }

export interface StagedResult {
  /** Path relative to the Deck Source root, POSIX-style (e.g. `assets/logo.png`). */
  relPath: string
  bytes: number
  mimeType: string
}

export interface StageAttachmentsResult {
  staged: StagedResult[]
  /** Per-input rejection reasons, parallel to refused inputs. */
  rejected: { name: string; reason: string }[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip directory components and sanitize a basename so it's safe to land on
 * disk regardless of platform: drop control chars, collapse whitespace, strip
 * any leading dots (so hidden/dotfile names become visible files). We
 * preserve the extension.
 */
function sanitizeFileName(raw: string): string {
  // `path.basename` is cross-platform aware (handles both / and \ on Windows).
  const base = path.basename(raw)
  // Replace control chars, slashes, and common FS-hostile chars with `-`.
  // Keep unicode letters/emoji — modern OSes are fine with them.
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
  if (cleaned) return cleaned
  // Pathological names like "...png" collapse to empty after leading-dot
  // strip. Preserve the extension from the original so downstream <img src>
  // / `file://` lookups still MIME-guess correctly, even if the stem is
  // just our "file" sentinel. Reject a degenerate single-dot extension.
  const ext = path.extname(base).toLowerCase()
  return ext && ext !== '.' ? `file${ext}` : 'file'
}

/**
 * Pick a destination filename that doesn't collide with existing entries.
 * Produces `name-2.ext`, `name-3.ext`, … — the same scheme the macOS Finder
 * uses for duplicate drops.
 */
function uniquify(destDir: string, fileName: string): string {
  const full = path.join(destDir, fileName)
  if (!existsSync(full)) return fileName
  const ext = path.extname(fileName)
  const stem = fileName.slice(0, fileName.length - ext.length)
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${stem}-${i}${ext}`
    if (!existsSync(path.join(destDir, candidate))) return candidate
  }
  // Pathological: give up with a timestamp suffix so we don't loop forever.
  return `${stem}-${Date.now()}${ext}`
}

function isAcceptable(fileName: string, mimeType: string): { ok: true } | { ok: false; reason: string } {
  const ext = path.extname(fileName).toLowerCase()
  if (REJECTED_EXT.has(ext)) {
    return { ok: false, reason: `${ext} is source code — paste the text or ask the AI to write it.` }
  }
  if (ALLOWED_EXT.has(ext)) return { ok: true }
  if (ALLOWED_MIME_PREFIX.some((p) => mimeType.startsWith(p))) return { ok: true }
  return { ok: false, reason: `Unsupported file type (${mimeType || ext || 'unknown'}).` }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Copy / write each input into `<rootDir>/assets/` and return the resolved
 * relative paths. Never throws for per-file validation errors — those land
 * in the `rejected` array so the renderer can surface them next to the
 * chip that caused them.
 */
export async function stageAttachments(rootDir: string, inputs: StagedInput[]): Promise<StageAttachmentsResult> {
  const assetsDir = path.join(rootDir, 'assets')
  await mkdir(assetsDir, { recursive: true })

  const staged: StagedResult[] = []
  const rejected: { name: string; reason: string }[] = []

  for (const input of inputs) {
    try {
      if (input.kind === 'path') {
        const originalName = path.basename(input.path)
        const safeName = sanitizeFileName(originalName)
        const mimeType = input.mimeType || ''
        const verdict = isAcceptable(safeName, mimeType)
        if (!verdict.ok) {
          rejected.push({ name: originalName, reason: verdict.reason })
          continue
        }
        // Stat the source first so we don't copy a 500MB movie just to
        // unlink it on the other side. `copyFile` on a multi-GB file can
        // also fail mid-write on small temp volumes.
        const srcStat = await stat(input.path)
        if (srcStat.size > MAX_ATTACHMENT_BYTES) {
          rejected.push({
            name: originalName,
            reason: `Over ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB limit.`,
          })
          continue
        }
        const finalName = uniquify(assetsDir, safeName)
        const destAbs = path.join(assetsDir, finalName)
        await copyFile(input.path, destAbs)
        staged.push({
          relPath: path.posix.join('assets', finalName),
          bytes: srcStat.size,
          mimeType: mimeType || 'application/octet-stream',
        })
      } else {
        const safeName = sanitizeFileName(input.fileName)
        const verdict = isAcceptable(safeName, input.mimeType)
        if (!verdict.ok) {
          rejected.push({ name: input.fileName, reason: verdict.reason })
          continue
        }
        const buf = Buffer.from(input.base64, 'base64')
        if (buf.length > MAX_ATTACHMENT_BYTES) {
          rejected.push({
            name: input.fileName,
            reason: `Over ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB limit.`,
          })
          continue
        }
        const finalName = uniquify(assetsDir, safeName)
        const destAbs = path.join(assetsDir, finalName)
        await writeFile(destAbs, buf)
        staged.push({
          relPath: path.posix.join('assets', finalName),
          bytes: buf.length,
          mimeType: input.mimeType,
        })
      }
    } catch (e) {
      const label = input.kind === 'path' ? path.basename(input.path) : input.fileName
      rejected.push({ name: label, reason: e instanceof Error ? e.message : String(e) })
    }
  }

  return { staged, rejected }
}
