// Styled wrapper around @radix-ui/react-select. Visual language matches
// the rest of the deck-app form controls: h-9 trigger with bg-surface +
// border-line-2, popover content uses bg-surface + border-line-2 +
// shadow-card-lift (same as AppMenu / Popover surfaces).
//
// API is flat-`items` for ungrouped lists OR `groups` for headed groups
// (builtin vs custom providers etc.). Pick one — passing both throws.
// Groups use Radix's Select.Group + Select.Label for accessibility.

import * as RS from '@radix-ui/react-select'
import { ChevronDown, Check } from 'lucide-react'
import { forwardRef } from 'react'
import { cn } from '#/renderer/lib/cn.ts'
import { POPOVER_SURFACE } from '#/renderer/components/ui/popover-surface.ts'

export interface SelectItem {
  value: string
  label: string
  disabled?: boolean
}

export interface SelectGroup {
  label: string
  items: SelectItem[]
}

interface SelectBase {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  ariaLabel?: string
  /** Extra classes on the trigger button. */
  className?: string
  disabled?: boolean
}

// Discriminated union: callers must pass exactly one of `items` (flat
// list) or `groups` (headed sections). Mutual exclusivity is enforced at
// compile time — passing both, or neither, fails typecheck. Headed
// sections render via Radix's Select.Group + Select.Label.
export type SelectProps = SelectBase &
  ({ items: SelectItem[]; groups?: never } | { groups: SelectGroup[]; items?: never })

export const Select = forwardRef<HTMLButtonElement, SelectProps>(function Select(
  props,
  ref,
) {
  const { value, onChange, placeholder, ariaLabel, className, disabled } = props
  // Discriminated union: exactly one of items/groups is supplied.
  // `'items' in props` narrows the union without a type cast.
  const items = 'items' in props ? props.items : undefined
  const groups = 'groups' in props ? props.groups : undefined

  return (
    <RS.Root value={value} onValueChange={onChange} disabled={disabled}>
      <RS.Trigger
        ref={ref}
        aria-label={ariaLabel}
        className={cn(
          'inline-flex h-9 w-full items-center justify-between gap-2 rounded-md border border-line-2 bg-surface px-2.5 text-[13px] text-ink',
          'cursor-pointer transition-colors',
          'hover:border-ink-4',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:border-accent',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          'data-[placeholder]:text-ink-3',
          '[-webkit-app-region:no-drag]',
          className,
        )}
      >
        <RS.Value placeholder={placeholder} />
        <RS.Icon asChild>
          <ChevronDown className="size-4 text-ink-3" aria-hidden />
        </RS.Icon>
      </RS.Trigger>
      <RS.Portal>
        <RS.Content
          // `popper` positions relative to the trigger; the default
          // `item-aligned` mode would re-anchor to the selected item
          // and feels jumpy when the list is short.
          position="popper"
          sideOffset={4}
          className={cn(
            POPOVER_SURFACE,
            'rounded-lg text-[13px]',
            // Match popper width to trigger so the popup feels attached.
            'min-w-[var(--radix-select-trigger-width)]',
            // Cap height so a long list doesn't push offscreen.
            'max-h-[min(var(--radix-select-content-available-height),320px)]',
            'data-[state=open]:zoom-in-95',
          )}
        >
          <RS.Viewport className="p-1">
            {items && items.map((it) => <Item key={it.value} item={it} />)}
            {groups &&
              groups.map((g, gi) => (
                <RS.Group key={g.label}>
                  {gi > 0 && <RS.Separator className="mx-1.5 my-1 h-px bg-line" />}
                  <RS.Label className="px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-ink-4">
                    {g.label}
                  </RS.Label>
                  {g.items.map((it) => <Item key={it.value} item={it} />)}
                </RS.Group>
              ))}
          </RS.Viewport>
        </RS.Content>
      </RS.Portal>
    </RS.Root>
  )
})

function Item({ item }: { item: SelectItem }) {
  return (
    <RS.Item
      value={item.value}
      disabled={item.disabled}
      className={cn(
        'relative flex cursor-pointer select-none items-center gap-2 rounded px-2.5 py-1.5 pr-7 text-[13px] text-ink outline-none',
        'data-[highlighted]:bg-line data-[highlighted]:text-ink',
        'data-[state=checked]:font-medium',
        'data-[disabled]:opacity-50 data-[disabled]:cursor-not-allowed',
      )}
    >
      <RS.ItemText>{item.label}</RS.ItemText>
      <RS.ItemIndicator className="absolute right-2 inline-flex">
        <Check className="size-3.5 text-accent" aria-hidden />
      </RS.ItemIndicator>
    </RS.Item>
  )
}
