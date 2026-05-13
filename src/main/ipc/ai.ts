import { dialog, ipcMain } from 'electron'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { stageAttachments, type StagedInput } from '#/main/attachments.ts'
import { deleteChatSession } from '#/main/chats.ts'
import { t } from '#/main/i18n/index.ts'
import { chromeOnly } from '#/main/ipc/guard.ts'
import { deleteSession, listSessions, readSession } from '#/main/ai/session-store.ts'
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
      // The session is locked to its creation-time provider — backends
      // read from session.record.provider, not from settings. So a
      // user changing settings.ai.provider mid-deck simply has no
      // effect on the active conversation; it kicks in for the next
      // New Chat. No IPC-level mismatch gate is needed.
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
      await appWindowByWebContents(event.sender)?.newAiChat()
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
      if (!deck) return { sessions: [], activeId: null } as const
      const records = await listSessions(deck.sourcePath)
      // Empty sessions (no successful turn yet) carry an empty
      // `summary`; hide them — the popover row would have nothing to
      // show. They stay on disk only as in-memory drafts until the
      // first turn lands.
      const visible = records.filter((r) => r.summary.length > 0)
      const activeId = w?.getAiSession()?.getRecord().id ?? null
      return {
        sessions: visible.map((r) => ({
          id: r.id,
          provider: r.provider,
          summary: r.summary,
          createdMs: r.createdMs,
          lastUsedMs: r.lastUsedMs,
        })),
        activeId,
      }
    }),
  )

  ipcMain.handle(
    'chats:switch',
    chromeOnly(async (event, sessionId: unknown) => {
      if (typeof sessionId !== 'string' || !sessionId) return { ok: false as const }
      const w = appWindowByWebContents(event.sender)
      if (!w?.getDeck()) return { ok: false as const }
      try {
        await w.switchAiSession(sessionId)
      } catch {
        return { ok: false as const }
      }
      return { ok: true as const }
    }),
  )

  ipcMain.handle(
    'chats:delete',
    chromeOnly(async (event, sessionId: unknown) => {
      if (typeof sessionId !== 'string' || !sessionId) return { ok: false as const }
      const w = appWindowByWebContents(event.sender)
      const deck = w?.getDeck()
      if (!w || !deck) return { ok: false as const }
      const active = w.getAiSession()?.getRecord()
      // Deleting the active session = "new chat": the manager tears
      // down the live backend before we remove the on-disk metadata.
      // Without this, the backend would happily keep writing to a
      // file we just unlinked.
      if (active && active.id === sessionId) {
        await w.newAiChat()
      }
      // Best-effort: also clean up the pi-agent JSONL when deleting a
      // pi-flavored session. CLI sessions store their transcript in
      // `~/.claude/projects/...` which is Claude's to manage.
      const target = await readSession(deck.sourcePath, sessionId)
      if (target && target.provider !== 'claude-cli' && target.providerSessionId) {
        deleteChatSession(deck.sourcePath, target.providerSessionId)
      }
      const ok = await deleteSession(deck.sourcePath, sessionId)
      return ok ? { ok: true as const } : { ok: false as const }
    }),
  )
}
