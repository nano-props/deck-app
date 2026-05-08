// Settings modal — Theme + Language + AI provider/key form.
// Wraps Radix Dialog so focus trap + Esc + outside-click come for free.

import { useEffect, useRef, useState } from 'react'
import * as RD from '@radix-ui/react-dialog'
import * as RTabs from '@radix-ui/react-tabs'
import { X } from 'lucide-react'
import { useI18n } from '#/renderer/stores/i18n.ts'
import { useAiStore } from '#/renderer/stores/ai.ts'
import { IconButton } from '#/renderer/components/ui/Button.tsx'
import { cn } from '#/renderer/lib/cn.ts'
import { AppearanceTab } from '#/renderer/components/SettingsOverlay/AppearanceTab.tsx'
import { AiTab } from '#/renderer/components/SettingsOverlay/AiTab.tsx'

// Match `animate-out` in styles.css (120ms) plus a frame of slack so the
// overlay's final transparent paint commits before the deckView re-shows.
// Under `prefers-reduced-motion: reduce` the animation is collapsed to
// ~0ms (see styles.css), so we drop the delay too — otherwise users who
// asked for less motion would see a longer black gap on the preview side.
const FADE_OUT_DELAY_MS = 140
function deckRevealDelayMs(): number {
  if (typeof window === 'undefined' || !window.matchMedia) return FADE_OUT_DELAY_MS
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : FADE_OUT_DELAY_MS
}

type DeckSnapshot = { dataUrl: string; rect: { x: number; y: number; width: number; height: number } }

export function SettingsOverlay() {
  const t = useI18n((s) => s.t)
  const [open, setOpen] = useState(false)
  // Snapshot of the deckView painted at its last-known bounds. Held
  // under the modal so the translucent mask actually has the deck
  // behind it — without this, hiding the deckView leaves only the
  // chromeView's empty background showing through, which reads as a
  // flat gray. Cleared after the close fade so the next open captures
  // a fresh frame (the deck may have changed in between).
  const [snapshot, setSnapshot] = useState<DeckSnapshot | null>(null)
  // Tracks whether the modal has ever opened in this component's lifetime.
  // Used to skip the close-side effects on initial mount, where `open` is
  // false but no real "close" has occurred — without this we'd fire a
  // pointless IPC + readiness refresh every time Editor loads.
  const hasOpenedRef = useRef(false)

  // Open via Topbar button (CustomEvent) AND main-process menu push.
  // Capture the deck frame BEFORE flipping `open` — otherwise the modal
  // fades in over the empty chromeView for a frame while we wait on the
  // capturePage round-trip.
  useEffect(() => {
    const openWithCapture = async () => {
      try {
        const snap = await window.deck.captureDeckView()
        if (snap) setSnapshot(snap)
      } catch {
        // capturePage can fail mid-teardown; modal still opens, just
        // without the deck behind it (matches the legacy behavior).
      }
      setOpen(true)
    }
    const onCustom = () => void openWithCapture()
    window.addEventListener('deck:open-settings', onCustom)
    const off = window.deck.onOpenSettings(() => void openWithCapture())
    return () => {
      window.removeEventListener('deck:open-settings', onCustom)
      off()
    }
  }, [])

  // Refresh the AI readiness gate when the overlay closes — the user
  // may have added/removed a key.
  useEffect(() => {
    if (open || !hasOpenedRef.current) return
    void useAiStore.getState().refreshReadiness()
  }, [open])

  // Hide the deck WebContentsView while the modal is up. The view paints
  // above the chromeView, so without this it would clip the modal where
  // they overlap (the right-pane preview region). The snapshot <img>
  // takes its place so the translucent overlay has something to "see
  // through".
  //
  // Open: hide synchronously so the deckView doesn't clip the fade-in.
  // Close: defer the reveal until Radix's fade-out animation has played
  // out — otherwise the deckView snaps back instantly on the right pane
  // while the chat-side overlay is still fading, producing a visibly
  // mismatched close animation between the two halves. Drop the
  // snapshot one tick AFTER the deckView reappears so there's never a
  // frame where neither is on screen.
  useEffect(() => {
    if (open) {
      hasOpenedRef.current = true
      void window.deck.setDeckViewVisible(false).catch(() => {})
      return
    }
    if (!hasOpenedRef.current) return
    let rafId = 0
    const id = setTimeout(() => {
      void window.deck.setDeckViewVisible(true).catch(() => {})
      // Hold the snapshot for one extra frame so the deckView's reveal
      // wins the race — dropping it earlier would briefly show the
      // empty chrome bg. The rAF is tracked so a quick reopen can
      // cancel it: without that, the user-rapid close→reopen path
      // would let the rAF fire after the new snapshot was set, wiping
      // the modal's backdrop to chrome bg for a frame.
      rafId = requestAnimationFrame(() => {
        rafId = 0
        setSnapshot(null)
      })
    }, deckRevealDelayMs())
    return () => {
      clearTimeout(id)
      if (rafId) cancelAnimationFrame(rafId)
    }
  }, [open])

  return (
    <RD.Root open={open} onOpenChange={setOpen}>
      <RD.Portal>
        {snapshot ? (
          <img
            src={snapshot.dataUrl}
            alt=""
            aria-hidden
            draggable={false}
            className="pointer-events-none fixed z-[99] select-none"
            style={{
              left: snapshot.rect.x,
              top: snapshot.rect.y,
              width: snapshot.rect.width,
              height: snapshot.rect.height,
            }}
          />
        ) : null}
        <RD.Overlay className="fixed inset-0 z-[100] bg-[rgb(10_10_10/0.55)] backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <RD.Content
          aria-describedby={undefined}
          className={cn(
            // Fixed dimensions so the modal doesn't resize between tabs —
            // Appearance is short, AI is tall; switching tabs would jolt
            // the dialog if we let height be content-driven.
            'fixed left-1/2 top-1/2 z-[101] flex w-[min(640px,92vw)] h-[min(540px,90vh)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden',
            'rounded-2xl border border-line bg-surface text-ink shadow-card-lift',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          )}
        >
          <header className="flex h-10 items-center justify-between pl-4 pr-2">
            <RD.Title className="text-[13px] font-semibold text-ink">{t('settings.title')}</RD.Title>
            <RD.Close asChild>
              <IconButton aria-label={t('aria.closeSettings')}>
                <X />
              </IconButton>
            </RD.Close>
          </header>
          <SettingsBody />
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  )
}

function SettingsBody() {
  const t = useI18n((s) => s.t)
  return (
    <RTabs.Root defaultValue="appearance" className="flex min-h-0 flex-1 flex-col">
      <RTabs.List aria-label={t('settings.title')} className="flex shrink-0 gap-1 border-b border-line px-4 pt-2">
        <SettingsTab value="appearance" label={t('settings.appearance')} />
        <SettingsTab value="ai" label={t('settings.ai')} />
      </RTabs.List>

      {/* Tab pane — the only scrolling region. */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <RTabs.Content value="appearance" className="focus-visible:outline-none">
          <AppearanceTab />
        </RTabs.Content>
        <RTabs.Content value="ai" className="focus-visible:outline-none">
          <AiTab />
        </RTabs.Content>
      </div>
    </RTabs.Root>
  )
}

// Underlined-pill tab. Inactive: muted text, hover bg. Active: ink text +
// 2px accent underline drawn via the bottom border, offset so it overlaps
// the list's own border-bottom (creates the "selected" notch effect).
function SettingsTab({ value, label }: { value: string; label: string }) {
  return (
    <RTabs.Trigger
      value={value}
      className={cn(
        'relative -mb-px rounded-t-md px-3 py-1.5 text-[13px] font-medium text-ink-2',
        'transition-colors hover:bg-line hover:text-ink',
        'data-[state=active]:text-ink',
        'data-[state=active]:after:absolute data-[state=active]:after:inset-x-2.5 data-[state=active]:after:bottom-0 data-[state=active]:after:h-0.5 data-[state=active]:after:bg-accent',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
      )}
    >
      {label}
    </RTabs.Trigger>
  )
}
