import { dialog, ipcMain } from 'electron'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { stageAttachments, type StagedInput } from '#/main/attachments.ts'
import { deleteChatSession, listDeckChatSessions } from '#/main/chats.ts'
import { t } from '#/main/i18n/index.ts'
import { chromeOnly } from '#/main/ipc/guard.ts'
import { appWindowByWebContents } from '#/main/window-registry.ts'
import type { ChatUiContext } from '#/main/ai/session/types.ts'

function parseChatUiContext(raw: unknown): ChatUiContext | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const v = raw as Partial<ChatUiContext>
  const lang = v.lang === 'en' || v.lang === 'zh' || v.lang === 'ko' ? v.lang : undefined
  const langPref =
    v.langPref === 'en' || v.langPref === 'zh' || v.langPref === 'ko' || v.langPref === 'auto' ? v.langPref : undefined
  const theme = v.theme === 'light' || v.theme === 'dark' ? v.theme : undefined
  const themePref =
    v.themePref === 'light' || v.themePref === 'dark' || v.themePref === 'auto' ? v.themePref : undefined
  return lang && langPref && theme && themePref ? { lang, langPref, theme, themePref } : undefined
}

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
    chromeOnly(async (event, text: unknown, uiContext: unknown) => {
      if (typeof text !== 'string' || text.trim().length === 0) {
        return { ok: false as const, reason: 'error' as const, error: 'empty message' }
      }
      const w = appWindowByWebContents(event.sender)
      const session = w?.getAiSession()
      if (!session) return { ok: false as const, reason: 'no-session' as const, error: 'no active AI session' }
      const result = await session.send(text, parseChatUiContext(uiContext))
      if (result.ok) return { ok: true as const }
      return { ok: false as const, reason: result.reason, error: result.message }
    }),
  )
  ipcMain.handle(
    'ai:abort',
    chromeOnly(async (event) => {
      // Awaited so the IPC return signals "agent has settled" — the
      // renderer can then issue a fresh send without racing the
      // still-shutting-down agent.
      await appWindowByWebContents(event.sender)?.getAiSession()?.abort()
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

  // Open an OS file picker and return basic metadata for the chosen files.
  // The renderer turns each entry into a staged-attachment chip via the
  // same path as drag/drop. We don't read bytes here — `app:attach-assets`
  // does that on send, so the user can review the chips before committing.
  ipcMain.handle(
    'app:pick-attachments',
    chromeOnly(async (event) => {
      const w = appWindowByWebContents(event.sender)
      if (!w) return { ok: false as const, files: [] }
      const deck = w.getDeck()
      if (!deck) return { ok: false as const, files: [] }
      const result = await dialog.showOpenDialog(w.getBaseWindow(), {
        title: t('dialog.attach.title'),
        buttonLabel: t('dialog.attach.button'),
        properties: ['openFile', 'multiSelections'],
      })
      if (result.canceled || result.filePaths.length === 0) return { ok: true as const, files: [] }
      // Stat each pick so the chip can show file size right away. mimeType
      // is left empty — the renderer's preflight uses extension as a
      // fallback, and the real magic-byte sniff happens in main on send.
      const files = await Promise.all(
        result.filePaths.map(async (p) => {
          let size = 0
          try {
            const s = await stat(p)
            size = s.size
          } catch {
            // Treat as unknown size — preflight only enforces an upper
            // bound, so size=0 just means "not yet known".
          }
          return { path: p, name: path.basename(p), size, mimeType: '' }
        }),
      )
      return { ok: true as const, files }
    }),
  )

  // ---- Chat history switcher ----------------------------------------------
  // The composer's History popover lists all persisted sessions for the
  // current deck, lets the user switch into one, or delete one. The
  // session files themselves are pi-managed JSONL on disk; these handlers
  // are thin wrappers around src/main/chats.ts.

  ipcMain.handle(
    'chats:list',
    chromeOnly(async (event) => {
      const w = appWindowByWebContents(event.sender)
      const deck = w?.getDeck()
      if (!deck) return { sessions: [], activePath: null } as const
      const sessions = await listDeckChatSessions(deck.sourcePath, deck.rootDir)
      // The active session's file path may be null when pi hasn't flushed
      // any messages yet (fresh "new chat" with no send) — in that case
      // there's nothing in the listing to highlight either.
      const activePath = w?.getAiSession()?.getSessionFile?.() ?? null
      return { sessions, activePath }
    }),
  )

  ipcMain.handle(
    'chats:switch',
    chromeOnly(async (event, sessionPath: unknown) => {
      if (typeof sessionPath !== 'string' || !sessionPath) return { ok: false as const }
      const w = appWindowByWebContents(event.sender)
      if (!w?.getDeck()) return { ok: false as const }
      // switchAiSession ultimately calls openDeckChatSession, which
      // throws if sessionPath escapes the deck's chat directory.
      // Surface a benign ok:false instead of an unhandled rejection.
      try {
        await w.switchAiSession(sessionPath)
      } catch {
        return { ok: false as const }
      }
      return { ok: true as const }
    }),
  )

  ipcMain.handle(
    'chats:delete',
    chromeOnly(async (event, sessionPath: unknown) => {
      if (typeof sessionPath !== 'string' || !sessionPath) return { ok: false as const }
      const w = appWindowByWebContents(event.sender)
      const deck = w?.getDeck()
      if (!w || !deck) return { ok: false as const }
      // If the user is deleting the currently-active session, treat it
      // like "new chat": reset the runtime first (which deletes its own
      // session file via resetDeckSessionManager), then short-circuit —
      // there's nothing else to delete.
      const active = w.getAiSession()?.getSessionFile?.()
      if (active && active === sessionPath) {
        await w.getAiSession()?.reset()
        return { ok: true as const }
      }
      // deleteChatSession scopes the rmSync to the deck's chat directory;
      // a path that escapes returns false (defence-in-depth). Renderer
      // uses the result to decide whether to drop the row optimistically.
      const ok = deleteChatSession(deck.sourcePath, sessionPath)
      return ok ? { ok: true as const } : { ok: false as const }
    }),
  )
}
