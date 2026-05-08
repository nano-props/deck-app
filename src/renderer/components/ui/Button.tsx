// Two button shapes: text `.btn` (primary/ghost/danger) and square
// `.icon-btn` for SVG-only triggers. Tailwind variants via tv() so
// parent components don't have to remember class strings.

import { tv, type VariantProps } from 'tailwind-variants'
import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '#/renderer/lib/cn.ts'

export const button = tv({
  base: cn(
    'inline-flex items-center justify-center gap-2 rounded-lg border font-medium font-sans',
    'cursor-pointer transition-colors duration-100',
    'disabled:opacity-50 disabled:cursor-not-allowed',
    '[-webkit-app-region:no-drag]',
  ),
  variants: {
    variant: {
      default: cn(
        'h-9 px-3.5 text-[13px]',
        'bg-surface text-ink border-line-2',
        'hover:border-ink-4',
      ),
      primary: cn(
        'h-9 px-3.5 text-[13px]',
        'bg-btn-solid text-btn-solid-text border-btn-solid',
        'hover:bg-btn-solid-hover hover:border-btn-solid-hover',
      ),
      ghost: cn('h-9 px-3.5 text-[13px] bg-transparent text-ink border-transparent', 'hover:bg-line'),
      danger: cn(
        'h-9 px-3.5 text-[13px] bg-transparent border-transparent',
        'text-[#c43a3a] hover:bg-line',
        "dark:text-[#ff7a7a]",
      ),
    },
    size: {
      sm: 'h-7 px-3 text-[12px]',
      md: '',
      lg: 'h-10 px-4 text-[14px]',
    },
  },
  defaultVariants: {
    variant: 'default',
    size: 'md',
  },
})

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, type = 'button', ...rest },
  ref,
) {
  return <button ref={ref} type={type} className={cn(button({ variant, size }), className)} {...rest} />
})

// ---- Icon button --------------------------------------------------------

export const iconButton = tv({
  base: cn(
    'inline-flex items-center justify-center rounded-md border border-transparent',
    'text-ink-2 bg-transparent cursor-pointer transition-colors duration-100',
    'hover:bg-line hover:text-ink',
    'active:bg-line-2',
    'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-2',
    '[-webkit-app-region:no-drag]',
  ),
  variants: {
    size: {
      sm: 'w-7 h-7 [&_svg]:w-3.5 [&_svg]:h-3.5',
      md: 'w-6 h-6 [&_svg]:w-4 [&_svg]:h-4',
      lg: 'w-8 h-8 [&_svg]:w-4 [&_svg]:h-4',
    },
  },
  defaultVariants: { size: 'md' },
})

export interface IconButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof iconButton> {}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, size, type = 'button', ...rest },
  ref,
) {
  return <button ref={ref} type={type} className={cn(iconButton({ size }), className)} {...rest} />
})
