// Themed wrapper around Radix Tooltip. Single provider at the app root;
// each tooltip target renders as <Tooltip content="..."><Button .../></Tooltip>.

import * as RT from '@radix-ui/react-tooltip'
import type { ReactNode } from 'react'
import { cn } from '#/renderer/lib/cn.ts'

export const TooltipProvider = ({ children }: { children: ReactNode }) => (
  <RT.Provider delayDuration={300} skipDelayDuration={300}>
    {children}
  </RT.Provider>
)

export interface TooltipProps {
  content: ReactNode
  children: ReactNode
  /** 'top' | 'bottom' | 'left' | 'right'; defaults to top. */
  side?: RT.TooltipContentProps['side']
  /** 'start' | 'center' | 'end'; defaults to center. Use 'end' on triggers
   *  near the right edge of a narrow pane so the bubble extends leftward
   *  instead of overflowing into a sibling pane. */
  align?: RT.TooltipContentProps['align']
  /** Disable when there's nothing to say (avoids empty bubble flicker). */
  disabled?: boolean
}

export function Tooltip({ content, children, side = 'top', align = 'center', disabled }: TooltipProps) {
  // Always wrap in RT.Root + RT.Trigger so toggling `disabled` (or
  // `content` between empty and non-empty) doesn't move children
  // between two different parent trees — that would unmount and
  // remount the child, dropping focus mid-interaction (the Composer
  // Send button hits this every time `unreadyReason` flips).
  // Suppressing only RT.Content keeps the trigger's React identity
  // stable while turning the bubble itself off.
  const showContent = !disabled && content !== '' && content != null
  return (
    <RT.Root>
      <RT.Trigger asChild>{children}</RT.Trigger>
      {showContent && (
        <RT.Portal>
          <RT.Content
            side={side}
            align={align}
            sideOffset={6}
            collisionPadding={8}
            className={cn(
              'z-[1000] max-w-[260px] rounded-md px-2 py-1.5 text-[11px] leading-snug',
              'bg-ink text-bg shadow-card',
              'dark:bg-[#2a2c30] dark:text-[#f2f3f5]',
              'data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95',
              'pointer-events-none select-none',
            )}
          >
            {content}
          </RT.Content>
        </RT.Portal>
      )}
    </RT.Root>
  )
}
