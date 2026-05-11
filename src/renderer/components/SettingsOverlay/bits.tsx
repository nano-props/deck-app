import * as RG from '@radix-ui/react-radio-group'
import { cn } from '#/renderer/lib/cn.ts'

/**
 * Settings section: small uppercase title + body of stacked Fields.
 * Used by AiTab / AboutTab to group related controls under a header
 * without a heavy divider line. Title is a `<h3>` for screen-reader
 * landmark navigation; the visual weight comes from `text-ink-3` +
 * tracking, not size, so it reads as a quiet label not a heading.
 */
export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">{title}</h3>
      <div className="flex flex-col gap-2.5">{children}</div>
    </section>
  )
}

// Form-field group: caption + control + optional hint, stacked.
// The caption is a `<span>`, NOT a `<label>` — we don't have an `htmlFor`
// target (each control varies: TextInput, Select, Segmented, custom),
// and a `<label>` without an associated control is mislabeled HTML that
// can confuse screen readers. Each control supplies its own accessible
// name via aria-label / placeholder / aria-labelledby on its primitive.
export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12px] font-semibold text-ink-2">{label}</span>
      {children}
      {hint && <p className="m-0 text-[12px] leading-snug text-ink-3">{hint}</p>}
    </div>
  )
}

/**
 * Segmented selector — a horizontal radio group rendered as flat pills.
 * Built on @radix-ui/react-radio-group so we get standard a11y for free:
 * roving tabindex (Tab enters the group, doesn't traverse each segment),
 * arrow-key navigation, role/aria-checked wiring, and home/end keys.
 *
 * Visually compact: meant for short option sets (3–6 items) sitting in
 * a Settings field. For richer items (icons + tooltips, raised pill
 * idiom) see `Topbar.tsx::ModeToggle` — kept separate by design.
 */
export function Segmented({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  ariaLabel: string
}) {
  return (
    <RG.Root
      value={value}
      onValueChange={onChange}
      aria-label={ariaLabel}
      className="inline-flex gap-0.5 self-start rounded-md border border-line-2 bg-surface p-0.5"
    >
      {options.map((o) => (
        <RG.Item
          key={o.value}
          value={o.value}
          className={cn(
            'rounded px-3 py-1 text-[12px] font-medium transition-colors cursor-pointer',
            'text-ink-2 hover:text-ink',
            'data-[state=checked]:bg-line data-[state=checked]:text-ink',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
          )}
        >
          {o.label}
        </RG.Item>
      ))}
    </RG.Root>
  )
}
