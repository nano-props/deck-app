// Status indicator for the AI tab. Renders in two shapes:
//
//   - <AiStatusChip> — compact pill (dot + label) for the credentials
//     card header. Shows the steady-state "Connected / Not connected"
//     when nothing is happening, and transient states (Saving / Pinging
//     / Saved / Error) inline as they fire.
//
//   - <AiStatusMessage> — full message line for ping responses. Only
//     renders when the status carries a meaningful body (`ok` with the
//     model echo, `err` with the failure reason). Saving/Saved/Pinging
//     don't have a body — the chip alone tells the story.

import { useI18n } from '#/renderer/stores/i18n.ts'
import { cn } from '#/renderer/lib/cn.ts'

/** Status of the auto-save + auto-ping pipeline.
 *  `saved` auto-fades to `idle` after a brief flash; everything else
 *  is sticky until the next event. */
export type AiStatus =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'pinging' }
  | { kind: 'ok'; msg: string }
  | { kind: 'cleared'; msg: string }
  | { kind: 'err'; msg: string }

/**
 * Tone the chip renders in. `connected` and `disconnected` are the
 * resting states (driven from outside — whether a key is configured),
 * not from the status enum, since `idle` doesn't tell us either.
 */
type ChipTone = 'connected' | 'disconnected' | 'pending' | 'ok' | 'err'

export function AiStatusChip({ status, hasKey }: { status: AiStatus; hasKey: boolean }) {
  const t = useI18n((s) => s.t)
  let tone: ChipTone
  let label: string
  switch (status.kind) {
    case 'saving':
      tone = 'pending'
      label = t('settings.status.saving')
      break
    case 'saved':
      tone = 'ok'
      label = t('settings.status.saved')
      break
    case 'pinging':
      tone = 'pending'
      label = t('settings.status.pinging')
      break
    case 'ok':
      tone = 'connected'
      label = t('settings.status.connected')
      break
    case 'cleared':
      tone = 'ok'
      label = t('settings.status.cleared')
      break
    case 'err':
      tone = 'err'
      label = t('settings.status.pingFailed')
      break
    case 'idle':
    default:
      tone = hasKey ? 'connected' : 'disconnected'
      label = hasKey ? t('settings.status.connected') : t('settings.status.notConnected')
  }
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium',
        (tone === 'connected' || tone === 'ok') && 'bg-[rgb(var(--color-success-rgb)/0.12)] text-success',
        tone === 'pending' && 'bg-line text-ink-2',
        tone === 'err' && 'bg-[rgb(var(--color-danger-rgb)/0.12)] text-danger',
        tone === 'disconnected' && 'bg-line text-ink-3',
      )}
    >
      <span
        className={cn(
          'size-1.5 rounded-full',
          (tone === 'connected' || tone === 'ok') && 'bg-success',
          tone === 'pending' && 'animate-pulse bg-ink-3',
          tone === 'err' && 'bg-danger',
          tone === 'disconnected' && 'bg-ink-4',
        )}
        aria-hidden
      />
      {label}
    </span>
  )
}

/**
 * Long-form status detail shown beneath the API key field. Renders
 * only when the latest status carries a meaningful message (ok / err);
 * other states are fully captured by the chip.
 */
export function AiStatusMessage({ status }: { status: AiStatus }) {
  if (status.kind !== 'ok' && status.kind !== 'err' && status.kind !== 'cleared') return null
  return (
    <p
      className={cn(
        'm-0 text-[12px] leading-snug',
        (status.kind === 'ok' || status.kind === 'cleared') && 'text-ink-3',
        status.kind === 'err' && 'text-danger',
      )}
    >
      {status.msg}
    </p>
  )
}
