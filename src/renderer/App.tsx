// Root layout — replicates the old grid-based shell:
//   row 1 (32px): Topbar (always)
//   row 2 (1fr):  mode-specific body (Launcher / EditorLayout / PlayerLayout)
//
// We keep `data-mode` / `data-subview` / `data-fullscreen` on <body>
// because some legacy CSS bits (and a couple of platform-specific
// adjustments) still target them. New code uses Tailwind classes.

import { useEffect } from 'react'
import { TOPBAR_PX } from '#/main/window-layout.ts'
import { useAppStore } from '#/renderer/stores/app.ts'
import { Topbar } from '#/renderer/components/Topbar.tsx'
import { Launcher } from '#/renderer/components/Launcher.tsx'
import { Editor } from '#/renderer/components/Editor.tsx'
import { Player } from '#/renderer/components/Player.tsx'
import { SettingsOverlay } from '#/renderer/components/SettingsOverlay/index.tsx'
import { AppMenu } from '#/renderer/components/AppMenu.tsx'
import { TooltipProvider } from '#/renderer/components/ui/Tooltip.tsx'

export function App() {
  // Per-field selectors so App only re-renders when one of these three
  // fields changes — the wider AppState (loading / deck / dirty) churns
  // for unrelated reasons.
  const mode = useAppStore((s) => s.mode)
  const subView = useAppStore((s) => s.subView)
  const isFullScreen = useAppStore((s) => s.isFullScreen)

  // Mirror state onto <body> data-* attributes for legacy CSS / platform
  // selectors that target them.
  useEffect(() => {
    const b = document.body
    b.setAttribute('data-mode', mode)
    b.setAttribute('data-subview', subView)
    b.toggleAttribute('data-fullscreen', isFullScreen)
  }, [mode, subView, isFullScreen])

  return (
    <TooltipProvider>
      <div className="grid h-full" style={{ gridTemplateRows: `${TOPBAR_PX}px 1fr` }}>
        <Topbar />
        <div className="relative min-h-0 min-w-0 overflow-hidden">
          {mode === 'launcher' && <Launcher />}
          {mode === 'deck' && subView === 'edit' && <Editor />}
          {mode === 'deck' && subView === 'play' && <Player />}
        </div>
        <SettingsOverlay />
        <AppMenu />
      </div>
    </TooltipProvider>
  )
}
