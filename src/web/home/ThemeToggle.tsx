// Sun/moon toggle, mirroring the vanilla docs button. The vanilla
// version cycles only between light and dark — auto support is in the
// store but we keep the homepage's two-state visual to avoid surprising
// existing users. (Auto is reachable through dev tools / localStorage
// for now; could be exposed if needed later.)

import { useTheme } from '#/web/lib/theme.ts'

export function ThemeToggle() {
  const resolved = useTheme((s) => s.resolved)
  const setPref = useTheme((s) => s.setPref)
  const isDark = resolved === 'dark'

  return (
    <button
      type="button"
      className="theme-btn"
      title="Toggle theme"
      aria-label="Toggle theme"
      onClick={() => setPref(isDark ? 'light' : 'dark')}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {isDark ? (
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        ) : (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
          </>
        )}
      </svg>
    </button>
  )
}
