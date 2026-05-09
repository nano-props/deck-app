// Styled <input> matching the form-control visual language used across
// Settings: h-9 surface card with hairline border, accent focus ring.
// `mono` swaps the font + size for fields that hold opaque tokens
// (API keys, IDs) where monospace aligns characters predictably.
//
// `trailing` renders icons / buttons absolutely positioned inside the
// right edge of the input frame, with extra padding-right so text
// doesn't slide under them. Use for clear-input X, password reveal eye,
// units, etc. — anything the user perceives as "part of this field"
// rather than a sibling control.

import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react'
import { cn } from '#/renderer/lib/cn.ts'

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  mono?: boolean
  /** Element rendered inside the input's right edge (e.g. X, eye). */
  trailing?: ReactNode
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { mono, trailing, className, ...rest },
  ref,
) {
  const input = (
    <input
      ref={ref}
      spellCheck={false}
      autoComplete="off"
      className={cn(
        'h-9 w-full rounded-md border border-line-2 bg-surface px-2.5 text-ink',
        'transition-colors',
        'hover:border-ink-4',
        'focus:outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/50',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        mono ? 'font-mono text-[12px]' : 'text-[13px]',
        // Reserve room for the trailing slot so typed text doesn't run
        // under the icon. Empirically 2.25rem covers a single 24px
        // IconButton with breathing space; bump if a caller stuffs more.
        trailing ? 'pr-9' : '',
        className,
      )}
      {...rest}
    />
  )
  if (!trailing) return input
  return (
    <span className="relative inline-flex w-full items-center">
      {input}
      {/*
        absolute over the input's right edge. pointer-events-none on the
        wrapper would block button clicks, so we leave events on but
        position outside the input's text-region pad.
      */}
      <span className="absolute right-1.5 inline-flex items-center gap-0.5">{trailing}</span>
    </span>
  )
})
