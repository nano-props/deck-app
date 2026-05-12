// Composer: textarea + tool cluster (new chat / history / attach) +
// staged attachments + Send/Stop.

import { useEffect, useRef, useState } from 'react'
import { SquarePen, Clock, Paperclip } from 'lucide-react'
import { useAiStore, canSendSelector } from '#/renderer/stores/ai.ts'
import { useAppStore } from '#/renderer/stores/app.ts'
import { useAttachments } from '#/renderer/stores/attachments.ts'
import { useChatStore } from '#/renderer/stores/chat.ts'
import { useI18n } from '#/renderer/stores/i18n.ts'
import { useTheme } from '#/renderer/stores/theme.ts'
import { Button, IconButton } from '#/renderer/components/ui/Button.tsx'
import { TextArea } from '#/renderer/components/ui/TextArea.tsx'
import { Tooltip } from '#/renderer/components/ui/Tooltip.tsx'
import { ChatHistoryPopover } from '#/renderer/components/ChatHistoryPopover.tsx'
import { cn } from '#/renderer/lib/cn.ts'
import { AttachmentChip } from '#/renderer/components/Composer/AttachmentChip.tsx'
import { blobToBase64 } from '#/renderer/components/Composer/attachment-utils.ts'
import { StatusBar } from '#/renderer/components/Composer/StatusBar.tsx'
import { useComposerDraft } from '#/renderer/components/Composer/useComposerDraft.ts'
import { useAutoGrow } from '#/renderer/components/Composer/useAutoGrow.ts'
import { usePromptHistory } from '#/renderer/components/Composer/usePromptHistory.ts'
import { useFileStaging } from '#/renderer/components/Composer/useFileStaging.ts'
import { humanBytes } from '#/renderer/components/Composer/format.ts'

export function Composer() {
  const t = useI18n((s) => s.t)
  const lang = useI18n((s) => s.lang)
  const langPref = useI18n((s) => s.pref)
  const theme = useTheme((s) => s.resolved)
  const themePref = useTheme((s) => s.pref)
  const streaming = useAiStore((s) => s.streaming)
  const unreadyReason = useAiStore((s) => s.unreadyReason)
  const setError = useAiStore((s) => s.setError)
  const canSend = useAiStore(canSendSelector)
  const attachments = useAttachments()
  const hasNodes = useChatStore((s) => s.nodes.length > 0)

  const inputRef = useRef<HTMLTextAreaElement>(null)
  const { text, setText } = useComposerDraft()
  const { setPendingCaret } = useAutoGrow(inputRef, text)
  const history = usePromptHistory(text, setText, setPendingCaret)
  const staging = useFileStaging()

  // Focus the chat input whenever the user is (or returns to) Edit
  // mode. Covers initial mount (subView starts at 'edit') and the
  // play→edit transition — DeckShell stays mounted across sub-views
  // now, so a mount-only focus would miss the return trip.
  const subView = useAppStore((s) => s.subView)
  useEffect(() => {
    if (subView === 'edit') inputRef.current?.focus()
  }, [subView])

  // Re-focus whenever the chat resets to empty — "New Chat" button,
  // the menu's reset shortcut, or a session switch. The user almost
  // certainly wants to start typing immediately after either trigger.
  useEffect(() => {
    const unsub = useChatStore.subscribe((state, prev) => {
      if (state.nodes.length === 0 && prev.nodes.length > 0) {
        inputRef.current?.focus()
      }
    })
    return unsub
  }, [])

  // New Chat is only meaningful when there's something to clear: a turn
  // in flight, prior messages, or staged attachments. Otherwise clicking
  // it would trigger a `deck:session_reset` round-trip that silently
  // wipes any chips the user staged but hadn't sent yet.
  const canStartNewChat = streaming || hasNodes || attachments.hasAny()

  // Whichever tooltip the user needs on Send: streaming → none (button is
  // hidden in favor of Stop); unready → reason hint; otherwise none.
  const sendTooltip = !streaming && unreadyReason ? t(`composer.disabled.${unreadyReason}` as any) : ''

  const [attachStatus, setAttachStatus] = useState('')
  // Local re-entrancy guard. `streaming` only flips true on the
  // server-driven `agent_start` event — between Send-click and that
  // event landing, a second click would otherwise enter `send()` and
  // race the first IPC. Guard locally so the gate is synchronous.
  const sendInFlightRef = useRef(false)
  // Set by Escape during the attaching/IPC window before the agent
  // streams. Each await in send() checks it and bails — the in-flight
  // attachAssets/aiSend can't actually be cancelled mid-IPC, but we
  // can refuse to act on their results so the user's "Esc to cancel"
  // intent feels honored. Reset on every fresh send.
  const sendAbortRef = useRef(false)

  async function send() {
    if (sendInFlightRef.current) return
    const userText = text.trim()
    const hasValid = attachments.hasValid()
    const hasRejectedOnly = !hasValid && attachments.hasAny()

    if (!userText && !hasValid) {
      if (hasRejectedOnly) setError(t('composer.removeBefore'))
      return
    }

    sendInFlightRef.current = true
    sendAbortRef.current = false
    // Clear the textarea immediately so the user can keep typing the
    // next prompt without waiting for the IPC round-trip. Stash the
    // captured text so we can restore it if the send rejects.
    const capturedText = text
    setText('')
    setError(null)

    let attachmentBlock = ''
    if (hasValid) {
      try {
        setAttachStatus(t('chat.status.attaching'))
        const inputs: (
          | { kind: 'path'; path: string; mimeType: string }
          | { kind: 'bytes'; fileName: string; mimeType: string; base64: string }
        )[] = attachments.items
          .filter((a) => !a.error)
          .map((a) =>
            a.source.kind === 'path'
              ? { kind: 'path' as const, path: a.source.path, mimeType: a.mimeType }
              : // Blob → base64. Done lazily here so paste-staged blobs
                // don't sit in memory pre-encoded.
                { kind: 'bytes' as const, fileName: a.name, mimeType: a.mimeType, base64: '' },
          )
        // Encode all blobs in parallel — FileReader.readAsDataURL is
        // off-thread, so concurrent reads don't pile onto the main
        // thread the way the old synchronous String.fromCharCode loop
        // did. We match each encoded base64 back to its inputs slot by
        // walking the same filtered order used to build `inputs` above
        // (instead of fileName matching, which would mis-route when the
        // user staged two same-named blobs).
        const blobIndices: number[] = []
        const blobPromises: Promise<string>[] = []
        let inputIdx = 0
        for (const a of attachments.items) {
          if (a.error) continue
          if (a.source.kind === 'blob') {
            blobIndices.push(inputIdx)
            blobPromises.push(blobToBase64(a.source.blob))
          }
          inputIdx++
        }
        const encoded = await Promise.all(blobPromises)
        if (sendAbortRef.current) {
          // User pressed Esc during base64 encode. Restore the input,
          // drop the in-flight flag, leave the chips so they can retry.
          setText((prev) => (prev === '' ? capturedText : prev))
          setAttachStatus('')
          sendInFlightRef.current = false
          return
        }
        for (let k = 0; k < blobIndices.length; k++) {
          const slot = inputs[blobIndices[k]]
          if (slot && slot.kind === 'bytes') slot.base64 = encoded[k]
        }
        const r = await window.deck.attachAssets(inputs)
        if (sendAbortRef.current) {
          // User pressed Esc while main was writing files. Main has
          // already staged them on disk (we can't undo that without a
          // new IPC), but we can refuse to feed them to the agent.
          setText((prev) => (prev === '' ? capturedText : prev))
          setAttachStatus('')
          sendInFlightRef.current = false
          return
        }
        if (!r?.ok) throw new Error(r?.error || 'attach failed')
        // Reconcile chips with main's verdict. Chips whose names appear
        // in `rejected` flip to red and stay so the user can see why and
        // dismiss them; chips that succeeded get removed alongside the
        // send.
        const rejectedByName = new Map<string, string>()
        for (const rej of r.rejected ?? []) rejectedByName.set(rej.name, rej.reason)
        const acceptedIds: number[] = []
        for (const a of attachments.items) {
          if (a.error) continue
          const reason = rejectedByName.get(a.name)
          if (reason) attachments.setError(a.id, reason)
          else acceptedIds.push(a.id)
        }
        // The agent's system prompt teaches it to read this block as
        // the canonical asset reference, so the format must stay stable
        // (one bullet per file with relPath + mimeType + size).
        if (r.staged && r.staged.length > 0) {
          const lines: string[] = ['<attached_files>']
          for (const s of r.staged) {
            lines.push(`- ${s.relPath} (${s.mimeType}, ${humanBytes(s.bytes)})`)
          }
          lines.push('</attached_files>')
          attachmentBlock = lines.join('\n')
        }
        // Drop accepted chips. Rejected (red) chips stay until the user
        // X's them — they're informative state, not in-flight work.
        if (acceptedIds.length > 0) attachments.removeMany(acceptedIds)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setError(msg)
        setAttachStatus('')
        // Restore the textarea — but only if the user hasn't started
        // typing the next prompt during the in-flight encode/IPC. Using
        // a functional update sees the *latest* state, not the closure-
        // captured value from when send() was called.
        setText((prev) => (prev === '' ? capturedText : prev))
        sendInFlightRef.current = false
        return
      }
      setAttachStatus('')
    }

    const fullText = attachmentBlock ? (userText ? `${attachmentBlock}\n\n${userText}` : attachmentBlock) : userText
    if (!fullText.trim()) {
      sendInFlightRef.current = false
      return
    }
    if (sendAbortRef.current) {
      // Last chance to bail before committing to the agent.
      setText((prev) => (prev === '' ? capturedText : prev))
      sendInFlightRef.current = false
      return
    }

    // Optimistic append BEFORE the IPC: a successful send streams back
    // assistant tokens that immediately follow this message in the
    // transcript, so showing the user's text up-front is the right UX.
    // For `busy` / `not-ready` / `no-session` refusals we roll back —
    // the agent never received the message, so leaving it in the
    // transcript would mislead the user about chat state.
    const userNodeId = useChatStore.getState().appendUser(fullText)

    try {
      const res = await window.deck.aiSend(fullText, { lang, langPref, theme, themePref })
      if (!res?.ok) {
        setError(res?.error || t('chat.status.sendFailed'))
        // Roll back the optimistic append for refusals where the agent
        // never received the message. `error` is the only reason that
        // means "the run actually started and failed" — a deck:fatal
        // event already landed in the transcript for that case, and
        // pairing it with the user message above is the right read.
        const reason = res ? res.reason : null
        if (reason === 'busy' || reason === 'not-ready' || reason === 'no-session') {
          useChatStore.getState().removeNode(userNodeId)
          // Only restore if the user hasn't started typing the next
          // prompt — otherwise we'd clobber their new draft.
          setText((prev) => (prev === '' ? capturedText : prev))
        }
      }
    } catch (e) {
      // IPC itself rejected — preload threw, channel closed, etc. The
      // agent didn't see the message, so roll back like a refusal.
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      useChatStore.getState().removeNode(userNodeId)
      setText((prev) => (prev === '' ? capturedText : prev))
    } finally {
      sendInFlightRef.current = false
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // CJK IME guard: while a composition is active (Pinyin / Kana /
    // Hangul candidate window open), Enter selects a candidate — it
    // MUST NOT submit. (Some browsers also fire `key === 'Process'`
    // during composition; checking both is belt-and-suspenders.)
    const composing = e.nativeEvent.isComposing || e.key === 'Process'
    if (composing) return
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      if (canSend) void send()
      return
    }
    if (e.key === 'Escape') {
      // Two cancel paths:
      //   - streaming: agent is mid-turn → server-side abort
      //   - sendInFlight && !streaming: we're between Send and the
      //     server's `agent_start` event, e.g. uploading attachments.
      //     Set the local abort flag so each await in send() bails on
      //     return; the IPCs themselves can't be killed mid-flight,
      //     but we refuse to act on their results.
      if (streaming) {
        e.preventDefault()
        void window.deck.aiAbort()
        return
      }
      if (sendInFlightRef.current) {
        e.preventDefault()
        sendAbortRef.current = true
        return
      }
    }
    // History navigation only kicks in at the very edge of the textarea
    // so it doesn't fight ordinary multi-line navigation.
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return
      const ta = e.currentTarget
      const atStart = ta.selectionStart === 0 && ta.selectionEnd === 0
      const atEnd = ta.selectionStart === ta.value.length && ta.selectionEnd === ta.value.length
      if (e.key === 'ArrowUp' && atStart) {
        e.preventDefault()
        history.navigate(-1)
      } else if (e.key === 'ArrowDown' && atEnd) {
        e.preventDefault()
        history.navigate(+1)
      }
    }
  }

  function wrapPasteInFence() {
    const range = staging.lastPasteRange
    if (!range) return
    const { start, end } = range
    if (end > text.length) {
      // Stale range (the user kept editing) — bail.
      staging.setLastPasteRange(null)
      return
    }
    const before = text.slice(0, start)
    const middle = text.slice(start, end)
    const after = text.slice(end)
    // Add surrounding newlines only if missing — avoids stacking blank
    // lines on follow-up wraps or when paste already started a new line.
    const lead = before === '' || before.endsWith('\n') ? '' : '\n'
    const tail = after === '' || after.startsWith('\n') ? '' : '\n'
    const wrapped = `${before}${lead}\`\`\`\n${middle}\n\`\`\`${tail}${after}`
    setText(wrapped)
    staging.setLastPasteRange(null)
    inputRef.current?.focus()
  }

  return (
    <form
      className="flex flex-col gap-2 border-t border-line bg-bg px-4 pb-3.5 pt-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (canSend) void send()
      }}
      onDragEnter={staging.onDragOver}
      onDragOver={staging.onDragOver}
      onDragLeave={staging.onDragLeave}
      onDrop={staging.onDrop}
    >
      {attachments.items.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {attachments.items.map((a) => (
            <AttachmentChip key={a.id} att={a} onRemove={() => attachments.remove(a.id)} />
          ))}
        </div>
      )}

      <div className="relative">
        <TextArea
          ref={inputRef}
          rows={1}
          value={text}
          onChange={(e) => {
            // Any user edit cancels history navigation — the textarea
            // is back to a "live draft" that ArrowDown won't try to
            // restore from freshDraftRef.
            history.resetToDraft()
            setText(e.target.value)
          }}
          onKeyDown={onKeyDown}
          onPaste={staging.onPaste}
          placeholder={t('composer.placeholder')}
          aria-label={t('aria.chatInput')}
          // min-h covers an empty box (1 line + padding); max-h caps
          // growth so a multi-screen paste turns into an internal
          // scroller instead of pushing the chat list off-screen.
          className="min-h-[2.25rem] max-h-[40vh] overflow-y-auto"
        />
        <div
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-0 flex items-center justify-center rounded-md border-2 border-dashed border-[rgb(var(--color-accent-rgb)/0.55)] bg-[rgb(var(--color-accent-rgb)/0.06)]',
            'transition-opacity duration-100',
            staging.composerDrag ? 'opacity-100' : 'opacity-0',
          )}
        >
          <span className="rounded-full bg-bg px-2.5 py-1 text-[12px] font-semibold text-accent shadow-sm">
            {t('composer.dropToAttach')}
          </span>
        </div>
      </div>

      {staging.lastPasteRange && (
        <button
          type="button"
          onClick={wrapPasteInFence}
          className={cn(
            'self-start rounded-md border border-line-2 bg-surface px-2 py-1 text-[11px] text-ink-2',
            'hover:bg-line hover:text-ink transition-colors',
          )}
        >
          {t('composer.wrapInFence')}
        </button>
      )}

      <div className="flex items-center gap-2">
        <div className="flex shrink-0 items-center gap-0.5">
          <Tooltip content={t('composer.newChat.title')}>
            <IconButton
              size="lg"
              aria-label={t('composer.newChat.aria')}
              disabled={!canStartNewChat}
              onClick={async () => {
                if (streaming) await window.deck.aiAbort().catch(() => {})
                await window.deck.aiReset().catch(() => {})
              }}
            >
              <SquarePen />
            </IconButton>
          </Tooltip>
          <ChatHistoryPopover
            trigger={
              <Tooltip content={t('composer.history.title')}>
                <IconButton size="lg" aria-label={t('composer.history.aria')}>
                  <Clock />
                </IconButton>
              </Tooltip>
            }
          />
          <Tooltip content={t('composer.attach.title')}>
            <IconButton
              size="lg"
              aria-label={t('composer.attach.aria')}
              onClick={async () => {
                await staging.pickFiles()
                inputRef.current?.focus()
              }}
            >
              <Paperclip />
            </IconButton>
          </Tooltip>
        </div>

        <StatusBar text={text} attachStatus={attachStatus} />

        {streaming ? (
          <Button onClick={() => void window.deck.aiAbort()}>{t('composer.stop')}</Button>
        ) : (
          <Tooltip content={sendTooltip} disabled={!sendTooltip} align="end">
            {/* Wrap in a span so the disabled state doesn't kill hover events.
                Native `disabled` blocks all pointer events on the button and
                Radix Tooltip would never see mouseenter — meaning the
                "why can't I send" hint vanishes exactly when it's most
                useful. The span passes hover through; aria-disabled marks
                the button for AT, and onClick gates the action. */}
            <span className="inline-flex">
              <Button
                type="submit"
                variant="primary"
                aria-disabled={!canSend}
                className={cn(!canSend && 'pointer-events-none opacity-50')}
                onClick={(e) => {
                  e.preventDefault()
                  if (canSend) void send()
                }}
              >
                <span>{t('composer.send')}</span>
                <span className="kbd">⏎</span>
              </Button>
            </span>
          </Tooltip>
        )}
      </div>
    </form>
  )
}
