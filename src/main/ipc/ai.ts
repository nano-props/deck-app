import { ipcMain } from 'electron'
import { stageAttachments, type StagedInput } from '#/main/attachments.ts'
import { chromeOnly } from '#/main/ipc/guard.ts'
import { appWindowByWebContents } from '#/main/window-registry.ts'

/**
 * AI chat + attachment staging. The Agent instance itself lives on the
 * AppWindow (see `getAiSession()`); these handlers just forward user
 * actions into it.
 *
 * Channels:
 *   ai:send / ai:abort / ai:reset   — user turn control
 *   app:attach-assets               — copy dropped/pasted files into the
 *                                     Deck Source so the agent can
 *                                     reference them by path
 */
export function wireAiIpc(): void {
  ipcMain.handle(
    'ai:send',
    chromeOnly(async (event, text: unknown) => {
      if (typeof text !== 'string' || text.trim().length === 0) return { ok: false, error: 'empty message' }
      const w = appWindowByWebContents(event.sender)
      const session = w?.getAiSession()
      if (!session) return { ok: false, error: 'no active AI session' }
      await session.send(text)
      return { ok: true }
    }),
  )
  ipcMain.handle(
    'ai:abort',
    chromeOnly((event) => {
      appWindowByWebContents(event.sender)?.getAiSession()?.abort()
    }),
  )
  ipcMain.handle(
    'ai:reset',
    chromeOnly(async (event) => {
      await appWindowByWebContents(event.sender)?.getAiSession()?.reset()
    }),
  )

  // Renderer collects dropped/pasted files into in-memory chips, then calls
  // this just before `ai:send` to persist them into the Deck Source. We
  // return the canonical relative paths so the renderer can prepend them
  // to the agent's user message in a structured block.
  ipcMain.handle(
    'app:attach-assets',
    chromeOnly(async (event, inputs: unknown) => {
      if (!Array.isArray(inputs)) return { ok: false as const, error: 'inputs must be an array' }
      const w = appWindowByWebContents(event.sender)
      const deck = w?.getDeck()
      if (!w || !deck) return { ok: false as const, error: 'no deck loaded' }
      if (deck.kind === 'pack') {
        return { ok: false as const, error: 'attachments require an unpacked Deck Source' }
      }
      // Narrow the `unknown[]` to StagedInput[] defensively — the preload is
      // trusted but we don't want a malformed renderer bug to crash main.
      const valid: StagedInput[] = []
      for (const raw of inputs) {
        if (!raw || typeof raw !== 'object') continue
        const item = raw as Record<string, unknown>
        if (item.kind === 'path' && typeof item.path === 'string') {
          valid.push({
            kind: 'path',
            path: item.path,
            mimeType: typeof item.mimeType === 'string' ? item.mimeType : '',
          })
        } else if (
          item.kind === 'bytes' &&
          typeof item.fileName === 'string' &&
          typeof item.mimeType === 'string' &&
          typeof item.base64 === 'string'
        ) {
          valid.push({ kind: 'bytes', fileName: item.fileName, mimeType: item.mimeType, base64: item.base64 })
        }
      }
      const result = await stageAttachments(deck.rootDir, valid)
      return { ok: true as const, ...result }
    }),
  )
}
