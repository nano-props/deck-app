import { X } from 'lucide-react'
import type { Attachment } from '#/renderer/stores/attachments.ts'
import { useI18n } from '#/renderer/stores/i18n.ts'
import { cn } from '#/renderer/lib/cn.ts'
import { humanBytes } from '#/renderer/components/Composer/format.ts'
import { kindLabel, kindToken } from '#/renderer/components/Composer/attachment-utils.ts'

export function AttachmentChip({ att, onRemove }: { att: Attachment; onRemove: () => void }) {
  const t = useI18n((s) => s.t)
  return (
    <div
      className={cn(
        'inline-grid grid-cols-[auto_1fr_auto] items-center gap-2 rounded-lg border bg-surface px-1 py-1 text-[12px] text-ink-2',
        'border-line-2 max-w-[260px]',
        att.error && 'border-[rgb(196_58_58/0.35)] bg-[rgb(196_58_58/0.06)]',
        att.error && 'dark:border-[rgb(255_122_122/0.4)] dark:bg-[rgb(255_122_122/0.08)]',
      )}
    >
      <span className="inline-flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md bg-line text-ink-4">
        {att.previewUrl ? (
          <img src={att.previewUrl} alt="" className="size-full object-cover" />
        ) : (
          <KindIcon mime={att.mimeType} name={att.name} />
        )}
      </span>
      <span className="flex min-w-0 flex-col pr-0.5 leading-tight">
        <span className="truncate font-medium text-ink">{att.name}</span>
        <span className="truncate text-[11px] text-ink-4">
          {att.error ?? `${kindLabel(att.mimeType, att.name, t)} · ${humanBytes(att.size)}`}
        </span>
      </span>
      <button
        type="button"
        onClick={onRemove}
        className="inline-flex size-5 items-center justify-center rounded text-ink-4 hover:bg-line hover:text-ink"
        title={t('attach.remove.title')}
        aria-label={t('attach.remove.aria', { name: att.name })}
      >
        <X className="size-3" />
      </button>
    </div>
  )
}

function KindIcon({ mime, name }: { mime: string; name: string }) {
  const k = kindToken(mime, name)
  if (k === 'video') {
    return (
      <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="m10 9 5 3-5 3z" />
      </svg>
    )
  }
  if (k === 'audio') {
    return (
      <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 18V5l12-2v13" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="18" cy="16" r="3" />
      </svg>
    )
  }
  if (k === 'font') {
    return (
      <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 7V5h16v2" />
        <path d="M9 19h6" />
        <path d="M12 5v14" />
      </svg>
    )
  }
  return (
    <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  )
}
