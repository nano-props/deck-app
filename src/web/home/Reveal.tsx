// Drop-in wrapper that adds the `.reveal` class plus the
// IntersectionObserver hook. Children render through unchanged.

import { type CSSProperties, type ElementType, type ReactNode } from 'react'
import { useReveal } from '#/web/home/useReveal.ts'
import { cn } from '#/web/lib/cn.ts'

interface Props {
  as?: ElementType
  className?: string
  id?: string
  style?: CSSProperties
  children: ReactNode
}

export function Reveal({ as: Tag = 'div', className, id, style, children }: Props) {
  const ref = useReveal<HTMLElement>()
  return (
    <Tag id={id} ref={ref} className={cn('reveal', className)} style={style}>
      {children}
    </Tag>
  )
}
