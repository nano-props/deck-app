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
import { useI18n } from '#/renderer/stores/i18n.ts'
import { cn } from '#/renderer/lib/cn.ts'
import { TooltipProvider } from '#/renderer/components/ui/Tooltip.tsx'
import { AppearanceTab } from '#/renderer/components/SettingsOverlay/AppearanceTab.tsx'
import { AiTab } from '#/renderer/components/SettingsOverlay/AiTab.tsx'
import { AboutTab } from '#/renderer/components/SettingsOverlay/AboutTab.tsx'

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
    window.history.replaceState(null, '', window.location.pathname)
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
      <div className="flex h-full min-h-0 bg-surface text-ink">
        <SidebarNav
          tab={tab}
          onChange={setTab}
          items={[
            { value: 'appearance', label: t('settings.appearance'), icon: Palette },
            { value: 'ai', label: t('settings.ai'), icon: Sparkles },
            { value: 'about', label: t('settings.about'), icon: Info },
          ]}
        />
        <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
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
      </div>
    </TooltipProvider>
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
    // Sidebar shares the main pane's background (no `bg-bg-deep` tint) —
    // matches modern macOS Settings, where the divider is the only thing
    // separating nav from content. Active item carries an accent fill so
    // it reads as the focal point without relying on a contrasting panel.
    <nav aria-label={t('settings.title')} className="flex w-[180px] shrink-0 flex-col gap-0.5 border-r border-line p-3">
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
              active ? 'bg-accent text-white' : 'text-ink-2 hover:bg-line hover:text-ink',
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
