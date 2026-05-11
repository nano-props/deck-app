// Top-level shell rendered in the standalone Settings BrowserWindow
// (mounted from `settings-main.tsx` → `settings.html`).
//
// Layout: left sidebar nav + right content pane. The sidebar gives a
// stable "where am I" anchor and scales cleanly past three tabs (Editor
// settings will land here later). Right pane has a unified content
// container so every tab shares the same max width / padding rhythm.
//
// Initial tab resolution: hash (deep-link from main) > sessionStorage
// (last tab in this window's lifetime) > 'appearance'. See INITIAL_TAB
// below for the why-now-not-in-useState reasoning.

import { useEffect, useState, type ReactNode } from 'react'
import { Palette, Sparkles, Info } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { SettingsTab } from '#/main/settings-window/index.ts'
import { TOPBAR_PX } from '#/main/window-layout.ts'
import { useI18n } from '#/renderer/stores/i18n.ts'
import { cn } from '#/renderer/lib/cn.ts'
import { TooltipProvider } from '#/renderer/components/ui/Tooltip.tsx'
import { AppearanceTab } from '#/renderer/components/SettingsOverlay/AppearanceTab.tsx'
import { AiTab } from '#/renderer/components/SettingsOverlay/AiTab.tsx'
import { AboutTab } from '#/renderer/components/SettingsOverlay/AboutTab.tsx'
import iconUrl from '#/renderer/assets/icon.png'

// True on Win/Linux — settings.html's boot script sets `data-chrome` to
// 'overlay' off-mac. Used to render Win/Linux-only brand affordances
// (the sidebar header that fills the caption row, kept off macOS where
// the traffic lights own that space). Read once at module load: the
// platform never changes mid-session.
const IS_OVERLAY_CHROME = document.documentElement.dataset.chrome === 'overlay'

const TAB_VALUES: readonly SettingsTab[] = ['appearance', 'ai', 'about']
const SS_KEY = 'deck:settings:tab'

function isTab(v: string | null | undefined): v is SettingsTab {
  return !!v && (TAB_VALUES as readonly string[]).includes(v)
}

// Resolve the initial tab at module-load time, not at component-mount
// time. Two reasons:
//   1. The hash is single-use — main passes it as a deep-link, we
//      consume it immediately and clear it. Doing this in `useState`'s
//      initializer breaks under React StrictMode's mount→unmount→mount
//      cycle: the second mount's initializer would see an empty hash
//      and fall back to sessionStorage (which is also empty until the
//      user clicks something), losing the deep-link intent.
//   2. Module top-level executes exactly once per renderer load,
//      sidestepping the StrictMode double-mount entirely.
const INITIAL_TAB: SettingsTab = (() => {
  const hashTab = window.location.hash.replace(/^#/, '')
  if (isTab(hashTab)) {
    // Strip the hash but preserve `?theme=...` so a Cmd+R reload still
    // boots into the correct theme via the inline boot script. Without
    // `+ search` here, the replaceState would erase the query too.
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
    return hashTab
  }
  const stored = sessionStorage.getItem(SS_KEY)
  if (isTab(stored)) return stored
  return 'appearance'
})()

export function SettingsApp() {
  const t = useI18n((s) => s.t)
  const [tab, setTabState] = useState<SettingsTab>(INITIAL_TAB)

  // Single setter for both user clicks and main-process pushes. Persists
  // to sessionStorage so a Cmd+R reload lands on the same tab.
  const setTab = (next: SettingsTab) => {
    setTabState(next)
    try {
      sessionStorage.setItem(SS_KEY, next)
    } catch {
      // sessionStorage can throw in private mode / quota — non-critical.
    }
  }

  // Subscribe to "switch tab" pushes from main — fired when the user
  // re-invokes openSettingsWindow with a different tab while we're already
  // open (e.g. clicked menu → About while the window was sitting on AI).
  useEffect(() => {
    return window.deck.onSettingsWindowSetTab?.((next) => {
      if (isTab(next)) setTab(next)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Tell main the React tree is mounted and tab-level flushers (AiTab,
  // any future tab) have registered themselves with the flush registry.
  // React guarantees child effects run before parent effects, so by the
  // time this fires every descendant's `registerFlusher` has executed.
  // Closes the race between `did-finish-load` and React's first commit:
  // a quit fired in that gap would otherwise see an empty registry.
  useEffect(() => {
    window.deck.notifySettingsWindowReady?.()
  }, [])

  return (
    // Wrap in TooltipProvider so Tooltip components inside AiTab (and any
    // future tab) can resolve Radix's Tooltip context. Without it Radix
    // throws "Tooltip must be used within Tooltip.Provider" the moment
    // a tab containing a tooltip mounts.
    <TooltipProvider>
      <div className="relative flex h-full min-h-0 bg-surface text-ink">
        <SidebarNav
          tab={tab}
          onChange={setTab}
          items={[
            { value: 'appearance', label: t('settings.appearance'), icon: Palette },
            { value: 'ai', label: t('settings.ai'), icon: Sparkles },
            { value: 'about', label: t('settings.about'), icon: Info },
          ]}
        />
        {/* Push the main scroll region below the drag strip with a
            margin-top, not internal padding. The strip is a transparent
            `-webkit-app-region: drag` overlay (no fill); offsetting the
            scroll region means main's content never enters the y=0..32
            zone in the first place, so we don't need an opaque strip
            to hide content scrolled past the top. The 32px gap reads
            naturally — it shares `bg-surface` with main itself, so
            visually main extends from the very top with breathing
            room above the first heading. */}
        <main
          className="flex min-h-0 flex-1 flex-col overflow-y-auto"
          style={{ marginTop: TOPBAR_PX }}
        >
          <div className="mx-auto w-full max-w-[520px] px-6 py-4">
            <TabPanel active={tab === 'appearance'}>
              <AppearanceTab />
            </TabPanel>
            <TabPanel active={tab === 'ai'}>
              <AiTab />
            </TabPanel>
            <TabPanel active={tab === 'about'}>
              <AboutTab />
            </TabPanel>
          </div>
        </main>
        <DragRegion />
      </div>
    </TooltipProvider>
  )
}

/** Empty, transparent drag strip giving the user a place to grab the
 *  window. macOS traffic lights and Win/Linux caption buttons are drawn
 *  by Electron in this region (positioned via `trafficLightPosition` /
 *  `titleBarOverlay` configured at window creation in
 *  `settings-window/index.ts`).
 *
 *  Stays transparent on purpose: the sidebar's `bg-bg-deep` panel
 *  reaches the top edge naturally and shows through here, so the brand
 *  row beneath the strip stays visible. The right half sits over
 *  `bg-surface` (the outer container) and the main scroll region is
 *  offset by `margin-top: TOPBAR_PX` so its content never enters this
 *  zone — no opaque fill needed to hide overscroll bleed.
 *
 *  `pointer-events: none` keeps the strip from blocking clicks on the
 *  SidebarBrand / nav buttons beneath it; `-webkit-app-region: drag`
 *  is a Chromium-level hint Electron reads independently of pointer
 *  events, so opting out is harmless. */
function DragRegion() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-0 [-webkit-app-region:drag]"
      style={{ height: TOPBAR_PX }}
    />
  )
}

function TabPanel({ active, children }: { active: boolean; children: ReactNode }) {
  if (!active) return null
  return <div>{children}</div>
}

interface NavItem {
  value: SettingsTab
  label: string
  icon: LucideIcon
}

function SidebarNav({
  tab,
  onChange,
  items,
}: {
  tab: SettingsTab
  onChange: (next: SettingsTab) => void
  items: NavItem[]
}) {
  const t = useI18n((s) => s.t)
  return (
    // Sidebar takes a slightly darker fill (`bg-bg-deep`) instead of a
    // 1px divider — same idiom as macOS System Settings, where the
    // sidebar / content separation reads through tone rather than a
    // line. The earlier border-r created a visible seam at the top
    // edge of the drag strip; a tonal panel sidesteps the seam entirely.
    //
    // Top spacing is platform-dependent: macOS leaves the top 32px empty
    // for the traffic lights (`pt-11` → 44px so the first nav item has
    // breathing room below), Win/Linux fills it with a brand header
    // (caption buttons sit on the *right* in `titleBarOverlay`, so the
    // left side of the bar is free for content).
    <nav
      aria-label={t('settings.title')}
      className={cn(
        'flex w-[180px] shrink-0 flex-col gap-0.5 bg-bg-deep px-3 pb-3',
        IS_OVERLAY_CHROME ? 'pt-2' : 'pt-11',
      )}
    >
      {IS_OVERLAY_CHROME && <SidebarBrand />}
      {items.map(({ value, label, icon: Icon }) => {
        const active = tab === value
        return (
          <button
            key={value}
            type="button"
            onClick={() => onChange(value)}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] font-medium',
              'cursor-pointer transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
              // Active nav uses the same solid fill as the launcher's
              // primary button (`bg-btn-solid`) so the app reads as
              // having one accent, not two — black on light, brand
              // blue on dark, both via the same token.
              active
                ? 'bg-btn-solid text-btn-solid-text'
                : 'text-ink-2 hover:bg-line hover:text-ink',
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            {label}
          </button>
        )
      })}
    </nav>
  )
}

/** Sidebar brand row (Win/Linux only). Sits in the column's top 32px,
 *  flush with the self-drawn drag strip — caption buttons live on the
 *  right edge of the window so the sidebar's left side is free. macOS
 *  uses `pt-11` instead so the traffic lights have the column to
 *  themselves; rendering this there would overlap them.
 *
 *  This row sits inside the sidebar's normal flow but a transparent
 *  absolute drag overlay (DragRegion) sits on top of it. The overlay
 *  carries `-webkit-app-region: drag` (Chromium hint Electron reads
 *  independently of pointer events), so dragging anywhere over the
 *  brand row moves the window — we don't have to mark the brand row
 *  itself draggable. The overlay's `pointer-events: none` keeps it
 *  from blocking clicks, and the row's content (icon + text) shows
 *  through because the overlay has no fill. */
function SidebarBrand() {
  return (
    <div
      className="mb-1 flex items-center gap-2 px-2"
      style={{ height: TOPBAR_PX }}
      aria-hidden
    >
      <img src={iconUrl} alt="" draggable={false} className="size-4 select-none" />
      <span className="text-[13px] font-semibold text-ink">Deck</span>
    </div>
  )
}
