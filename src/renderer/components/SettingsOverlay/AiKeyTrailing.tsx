// Trailing icon cluster inside the apiKey TextInput's right edge.
// X / Trash2 / Eye are mutually constrained by input + keychain state:
//
//   - input has unsaved text → X clears the input (cheap undo)
//   - input empty AND keychain has a saved key → Trash with native
//     confirm clears the keychain entry
//   - eye toggle is always rendered (disabled when input is empty) so
//     the right edge doesn't jump when icons swap.

import { Eye, EyeOff, Trash2, X } from 'lucide-react'
import { useI18n } from '#/renderer/stores/i18n.ts'
import { IconButton } from '#/renderer/components/ui/Button.tsx'
import { Tooltip } from '#/renderer/components/ui/Tooltip.tsx'

export function AiKeyTrailing({
  hasInput,
  hasSavedKey,
  revealed,
  onClearInput,
  onDeleteSaved,
  onToggleReveal,
}: {
  hasInput: boolean
  hasSavedKey: boolean
  revealed: boolean
  onClearInput: () => void
  onDeleteSaved: () => void
  onToggleReveal: () => void
}) {
  const t = useI18n((s) => s.t)
  return (
    <>
      {hasInput ? (
        <Tooltip content={t('settings.apiKey.clearInput')}>
          <IconButton
            size="sm"
            onClick={onClearInput}
            // Prevent input blur on icon click — clicking X should
            // wipe the field, not commit the partial value to keychain.
            onMouseDown={(e) => e.preventDefault()}
            aria-label={t('settings.apiKey.clearInput')}
          >
            <X />
          </IconButton>
        </Tooltip>
      ) : hasSavedKey ? (
        <Tooltip content={t('settings.apiKey.deleteSaved')}>
          <IconButton
            size="sm"
            onClick={onDeleteSaved}
            onMouseDown={(e) => e.preventDefault()}
            aria-label={t('settings.apiKey.deleteSaved')}
            className="text-danger hover:text-danger"
          >
            <Trash2 />
          </IconButton>
        </Tooltip>
      ) : null}
      <Tooltip
        disabled={!hasInput}
        content={revealed ? t('settings.toggleReveal.hide') : t('settings.toggleReveal.show')}
      >
        <IconButton
          size="sm"
          disabled={!hasInput}
          onClick={onToggleReveal}
          // Keep blur from firing on the eye toggle either; the user
          // hasn't finished entering the key yet.
          onMouseDown={(e) => e.preventDefault()}
          aria-label={t('aria.toggleKey')}
          data-revealed={revealed}
        >
          {revealed ? <EyeOff /> : <Eye />}
        </IconButton>
      </Tooltip>
    </>
  )
}
