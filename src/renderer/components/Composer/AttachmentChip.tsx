import { AudioLines, File, Type, Video, X } from 'lucide-react'
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
        att.error && 'border-[rgb(var(--color-danger-rgb)/0.35)] bg-[rgb(var(--color-danger-rgb)/0.07)]',
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
  const cls = 'size-4'
  if (k === 'video') return <Video className={cls} />
  if (k === 'audio') return <AudioLines className={cls} />
  if (k === 'font') return <Type className={cls} />
  return <File className={cls} />
}
