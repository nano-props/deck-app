// Styled <textarea> matching ui/TextInput's form-control visual language:
// surface card with hairline border, accent focus ring on keyboard focus.
// Used by Composer; ready to share if any other multi-line input shows up.
//
// What's NOT baked in:
//   - sizing (min-h / max-h / rows): caller decides — Composer wants
//     auto-grow from 1 row to 40vh, future callers may want a fixed box.
//   - overflow: pairs with sizing, so it's a caller concern too.
//   - resize handle: hidden by default with `resize-none`; the auto-grow
//     hook handles height, and a draggable handle would fight it. Pass
//     `resize="vertical"` etc. through {...rest} to override.

import { forwardRef, type TextareaHTMLAttributes } from 'react'
import { cn } from '#/renderer/lib/cn.ts'

export type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement>

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { className, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      // CJK characters trip the OS spellchecker (no installed dictionary
      // matches), producing wavy red lines that read as noise rather
      // than help. Off by default; callers can override via {...rest}.
      spellCheck={false}
      className={cn(
        'block w-full resize-none rounded-md border border-line-2 bg-surface px-3 py-2.5',
        'font-sans text-[13px] leading-snug text-ink',
        'transition-colors',
        'hover:border-ink-4',
        'focus:outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/50',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        // Drag-region context (macOS chrome): keep text selectable.
        '[user-select:text] [-webkit-user-select:text]',
        className,
      )}
      {...rest}
    />
  )
})
