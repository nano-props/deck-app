// Topbar — persistent 32px row across all modes.
//
// Layout: 1fr | auto | 1fr  (left cluster | centered title | right cluster)
// `-webkit-app-region: drag` on the row, with `no-drag` on the buttons
// inherited from the global rule in styles.css. Win/Linux right padding
// reserves space for the OS caption buttons (titleBarOverlay sits there).
//
// Cluster grouping:
//   Left:  app menu (Win/Linux only) + Mode segmented (Play / Edit) +
//          Save (Edit-mode only)
//          — the "Edit workflow" cluster: Save is bound to Edit mode
//          (it disappears in Play / Source-kind decks), so it sits next
//          to the segmented control rather than across the bar.
//   Right: Reload + Settings
//          — mode-agnostic actions: Reload exists in both Play and
//          Edit; Settings is global. These are the "ambient" controls.
//
// Splitting Edit-bound vs. ambient across left/right balances the row's
// visual weight and ties Save's appearance to the segmented control's
// state — Play mode hides both the Save button and (visually) drops the
// segmented control's right end, giving consistent feedback.

import { Menu as MenuIcon, Play, Pencil, Save, RotateCcw, Settings as SettingsIcon, Maximize2 } from 'lucide-react'
import { useAppStore } from '#/renderer/stores/app.ts'
import { useI18n } from '#/renderer/stores/i18n.ts'
import { useSettingsModal } from '#/renderer/stores/settings-modal.ts'
import { IconButton } from '#/renderer/components/ui/Button.tsx'
import { Tooltip } from '#/renderer/components/ui/Tooltip.tsx'
import { cn } from '#/renderer/lib/cn.ts'

export function Topbar() {
  const t = useI18n((s) => s.t)
  const mode = useAppStore((s) => s.mode)
  const subView = useAppStore((s) => s.subView)
  const deck = useAppStore((s) => s.deck)

  const isDeck = mode === 'deck'
  const dirty = useAppStore((s) => s.dirty)

  // Save shows for Pack-kind decks in edit sub-view. Source kind writes
  // through to the user's directory directly — there's nothing to flush.
  const showSave = isDeck && subView === 'edit' && deck?.kind === 'pack'
  const showReload = isDeck
  // Maximize button only in Player. Calls togglePresentation, which
  // drives the deckView into HTML5 fullscreen (browser-style, deck
  // content alone fills the screen). Click again or Esc exits; the
  // main-side listener pairs OS fullscreen so the titlebar also hides.
  const showFullScreen = isDeck && subView === 'play'

  return (
    <header
      className={cn(
        'topbar grid grid-cols-[1fr_auto_1fr] items-center gap-2 bg-bg z-[2]',
        'shadow-[0_1px_0_rgb(10_10_10/0.03)]',
        'dark:shadow-[0_1px_0_rgb(255_255_255/0.04)]',
        // Padding rules (mac vs Win/Linux) live in styles.css under
        // `.topbar` / `html[data-chrome='overlay'] .topbar` because
        // Tailwind v4 can't express "html[data-chrome=overlay] selector"
        // as a JIT class — too much escaping.
        '[-webkit-app-region:drag]',
      )}
    >
      <div className="flex min-w-0 items-center gap-1 pl-2">
        {/* App menu — visible on Win/Linux only, gated by .app-menu-trigger
            CSS rule in styles.css (default hidden, flips to inline-flex
            when html[data-chrome='overlay']). */}
        <Tooltip content={t('topbar.appMenu')} side="bottom">
          <IconButton
            id="appMenuTrigger"
            aria-label={t('topbar.appMenu')}
            className="app-menu-trigger"
          >
            <MenuIcon />
          </IconButton>
        </Tooltip>
        {isDeck && <ModeToggle subView={subView} />}
        {showSave && (
          <Tooltip content={t('topbar.save.title')} side="bottom">
            <IconButton
              aria-label={t('topbar.save.aria')}
              onClick={() => void window.deck.saveDeck()}
              className={cn(
                'relative',
                // `pointer-events-none` on the dirty indicator so it can't
                // intercept hover from reaching the underlying button —
                // otherwise Radix Tooltip's pointer-enter detection silently
                // misses the trigger when the cursor lands on the dot.
                dirty && "after:absolute after:top-1 after:right-1 after:size-1.5 after:rounded-full after:bg-accent after:content-[''] after:pointer-events-none",
              )}
            >
              <Save />
            </IconButton>
          </Tooltip>
        )}
      </div>

      <div className="flex items-center justify-center">
        <div
          className={cn(
            'truncate text-center font-semibold text-ink text-[13px]',
            'tracking-tight max-w-[40ch]',
          )}
        >
          {isDeck ? deck?.manifest?.name ?? 'Deck' : 'Deck'}
        </div>
      </div>

      <div className="flex min-w-0 items-center justify-end gap-1 pr-1">
        {showFullScreen && (
          <Tooltip content={t('topbar.fullScreen.title')} side="bottom">
            <IconButton
              aria-label={t('topbar.fullScreen.aria')}
              onClick={() => void window.deck.togglePresentation()}
            >
              <Maximize2 />
            </IconButton>
          </Tooltip>
        )}
        {showReload && (
          <Tooltip content={t('topbar.reload.title')} side="bottom">
            <IconButton
              aria-label={t('topbar.reload.aria')}
              onClick={() => void window.deck.reloadPreview()}
            >
              <RotateCcw />
            </IconButton>
          </Tooltip>
        )}

        <Tooltip content={t('topbar.settings.title')} side="bottom">
          <IconButton
            id="settingsBtn"
            aria-label={t('topbar.settings.aria')}
            onClick={() => void useSettingsModal.getState().requestOpen()}
          >
            <SettingsIcon />
          </IconButton>
        </Tooltip>
      </div>
    </header>
  )
}

/**
 * Two-segment Play / Edit toggle. Replaces the old single-button toggle
 * that advertised the *target* view — which forced users to read the
 * icon as "what I'm not currently in" rather than "what I'm in now".
 *
 * The segmented control shows current state directly: highlighted
 * segment = current sub-view. Clicking the inactive segment switches.
 */
// Why this isn't `bits.tsx::Segmented`: visual idiom differs (macOS-style
// raised pill via shadow vs. flat bg-line highlight), size is fixed at
// 24px to match neighboring IconButtons, segments carry icons + per-side
// tooltips. Generalizing Segmented to cover both call sites would add
// size + active-style + node-label + tooltip-slot variants for one extra
// caller; the duplication is shallow enough to keep them separate.
function ModeToggle({ subView }: { subView: 'edit' | 'play' }) {
  const t = useI18n((s) => s.t)
  // Sizing target: total height = 24px to match neighboring IconButtons
  // (md = 24x24). Outer p-px (1px) + segment h-[22px] = 24px exact.
  const segment = cn(
    'inline-flex items-center justify-center w-7 h-[22px] rounded-[5px] transition-colors duration-100',
    'cursor-pointer text-ink-2 hover:text-ink',
    '[-webkit-app-region:no-drag]',
    '[&_svg]:w-3.5 [&_svg]:h-3.5',
  )
  const active = 'bg-bg text-ink shadow-[0_1px_2px_rgb(10_10_10/0.08)] dark:shadow-[0_1px_2px_rgb(0_0_0/0.4)]'
  return (
    <div
      role="group"
      aria-label={t('topbar.mode.aria')}
      className="inline-flex items-center gap-0.5 rounded-md bg-line p-px"
    >
      <Tooltip content={t('topbar.mode.play')} side="bottom">
        <button
          type="button"
          aria-label={t('topbar.mode.play')}
          aria-pressed={subView === 'play'}
          onClick={() => {
            if (subView !== 'play') void window.deck.enterPlayer()
          }}
          className={cn(segment, subView === 'play' && active)}
        >
          <Play />
        </button>
      </Tooltip>
      <Tooltip content={t('topbar.mode.edit')} side="bottom">
        <button
          type="button"
          aria-label={t('topbar.mode.edit')}
          aria-pressed={subView === 'edit'}
          onClick={() => {
            if (subView !== 'edit') void window.deck.enterEditor()
          }}
          className={cn(segment, subView === 'edit' && active)}
        >
          <Pencil />
        </button>
      </Tooltip>
    </div>
  )
}
