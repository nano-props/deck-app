// Shared className for floating-surface panels — Radix Popover.Content
// and Select.Content (the two we currently use). These render in a portal
// above the app and share the same visual language: surface bg, hairline
// border, lifted shadow, fade-in on open. New floating panels (DropdownMenu,
// HoverCard, etc.) can adopt this constant when they show up.
//
// z-[110] sits above the Settings Dialog (Overlay z-100, Content z-101).
// This is deliberate: a Select / Popover opened *inside* a dialog must
// render above the dialog backdrop, otherwise it disappears behind it.
// AppMenu / ChatHistoryPopover are outside any dialog and z-110 is fine
// against the topbar / chat-pane (both well below 100).
//
// Per-call-site bits stay at the call site:
//   - radius (rounded-lg vs rounded-xl)
//   - sizing (min/max width, max-height)
//   - entrance animation modifier (zoom-in-95 vs slide-in-from-bottom-1)
//   - typography (text-[13px] etc.)
//   - layout (flex / flex-col when the panel composes children vertically)
//
// We don't wrap these in a React component because Radix's Content slots
// come from different packages and aren't interchangeable. A className
// constant is the right granularity: deduped styling without forcing
// architectural symmetry that doesn't exist.
export const POPOVER_SURFACE =
  'z-[110] overflow-hidden border border-line-2 bg-surface text-ink shadow-card-lift ' +
  'data-[state=open]:animate-in data-[state=open]:fade-in-0 ' +
  'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 ' +
  '[-webkit-app-region:no-drag]'
