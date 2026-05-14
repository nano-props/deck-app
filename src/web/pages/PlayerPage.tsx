// PlayerPage — top-level player composition.
//
// Wires:
//   - Loader (imperative class) ↔ usePlayer zustand store via hooks
//   - Router (imperative) ↔ Loader
//   - Keyboard (⌘K, ?, Esc routing) ↔ Palette
//   - File input + drag-drop ↔ Loader
//   - Recents list ↔ Cache API + Loader
//
// Loader is created once in a ref and lives as long as the page.
// Router is similarly long-lived. Neither participates in React's
// reconciliation — they're effects on `document` / `history`.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useI18n, asHtml } from '#/web/lib/i18n.ts'
import { Loader } from '#/web/player/loader.ts'
import { createRouter, type Router } from '#/web/player/router.ts'
import {
  softDeleteDeck,
  restoreDeck,
  commitDeleteDeck,
  type LruEntry,
} from '#/web/player/cache.ts'
import { usePlayer } from '#/web/player/state.ts'
import { toast } from '#/web/player/undo-toast.ts'
import { DropZone } from '#/web/player/DropZone.tsx'
import { Stage } from '#/web/player/Stage.tsx'
import { RecentsList } from '#/web/player/RecentsList.tsx'
import { Palette } from '#/web/player/Palette.tsx'
import { UndoToast } from '#/web/player/UndoToast.tsx'

export function PlayerPage() {
  const t = useI18n((s) => s.t)
  const status = usePlayer((s) => s.status)
  const error = usePlayer((s) => s.error)
  const activeDeckId = usePlayer((s) => s.activeDeckId)
  const setStatus = usePlayer((s) => s.setStatus)
  const setError = usePlayer((s) => s.setError)
  const setActive = usePlayer((s) => s.setActive)
  const bumpRecents = usePlayer((s) => s.bumpRecents)

  const frameRef = useRef<HTMLIFrameElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const loaderRef = useRef<Loader | null>(null)
  const routerRef = useRef<Router | null>(null)

  const [paletteOpen, setPaletteOpen] = useState(false)

  // ---- Loader + Router boot. Runs once per mount. -----------------
  useEffect(() => {
    if (!frameRef.current) return
    const loader = new Loader({
      frameEl: frameRef.current,
      setStatus,
      setError,
      onStageShown: (deckId, manifestName) => {
        setActive(deckId, manifestName)
        document.title = (manifestName || 'Deck') + ' — Deck Player'
        // Drop the inline "restoring" cloak (set in <head> when the
        // URL had a hash on first load). The stage now covers the
        // upload screen anyway, but we don't want the cloak lingering
        // for the eventual back navigation.
        document.documentElement.classList.remove('restoring')
        bumpRecents()
      },
      onClosed: () => {
        setActive(null, '')
        setStatus('')
        document.title = 'Deck Player'
        document.documentElement.classList.remove('restoring')
        bumpRecents()
      },
      onLoadFailed: () => {
        // The "restoring" cloak is set in <head> when the URL has a
        // hash; a refresh that hits a real error needs the cloak
        // dropped so the user can see the message instead of a blank
        // page.
        document.documentElement.classList.remove('restoring')
      },
    })
    loaderRef.current = loader

    const router = createRouter({
      onHash: async (hash) => {
        const result = await loader.loadFromHash(hash)
        if (result === 'missing') {
          // Strip the dangling hash, collapse the stage, and surface a
          // clear explanation. close() bumps generation + fires
          // onClosed, which clears status; setError after that.
          router.clearHash()
          loader.close()
          setError(t('playerUrlNotShareable'))
        }
      },
      onEmpty: () => loader.close(),
    })
    routerRef.current = router

    // Escape hatch path doesn't get here — the entry script handles
    // it before mounting React. Normal boot dispatches initial route.
    router.start()
    // We intentionally never tear Loader/Router down — they live for
    // the lifetime of the page. eslint-disable-next-line is unneeded
    // because the deps are stable refs from store actions.
  }, [setStatus, setError, setActive, bumpRecents, t])

  // ---- Keyboard: ⌘K / ? toggles palette ----------------------------
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Don't intercept while the user is typing into a form field.
      const tgt = e.target as HTMLElement | null
      if (
        tgt &&
        (tgt.tagName === 'INPUT' ||
          tgt.tagName === 'TEXTAREA' ||
          tgt.isContentEditable)
      ) {
        return
      }
      if (!loaderRef.current?.hasActiveDeck) return

      const isMod = e.metaKey || e.ctrlKey
      if ((isMod && e.key.toLowerCase() === 'k') || (!isMod && e.key === '?')) {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // ---- Recents handlers -------------------------------------------
  const openRecent = useMemo(
    () => async (deckId: string) => {
      const loader = loaderRef.current
      const router = routerRef.current
      if (!loader || !router) return
      if (deckId === loader.currentDeckId) return
      router.pushHash(deckId)
      await loader.loadFromHash(deckId)
    },
    [],
  )

  const handleDelete = useMemo(
    () => (deckId: string, name: string) => {
      const entry: LruEntry | null = softDeleteDeck(deckId)
      if (!entry) return
      bumpRecents()
      toast.show({
        message: t('toastRemoved', { name: name || 'deck' }),
        onUndo: () => {
          restoreDeck(deckId, entry)
          bumpRecents()
        },
        onCommit: () => {
          // Pass the soft-deleted entry: if the user has since
          // re-opened the same deck, the LRU will have a newer ts and
          // commit will be a no-op so we don't wipe the freshly-loaded
          // deck.
          commitDeleteDeck(deckId, entry).catch((err) => {
            console.error('Failed to commit deck deletion:', err)
          })
        },
      })
    },
    [t, bumpRecents],
  )

  const onFile = (file: File) => {
    void loaderRef.current?.loadFromFile(file)
  }

  // ---- Render -----------------------------------------------------
  const stageActive = activeDeckId !== null
  return (
    <>
      <header className="flex items-center justify-between px-6 py-3.5 border-b border-line bg-[color-mix(in_srgb,var(--color-bg)_82%,transparent)] backdrop-blur-md sticky top-0 z-[5]">
        <div className="font-semibold text-lg tracking-[-0.015em]">
          {t('playerBrand')}
        </div>
        <nav className="flex items-center gap-1">
          <a
            href="../"
            target="_blank"
            rel="noopener"
            className="text-[13px] font-medium text-ink-2 px-3 py-2 rounded-lg transition-colors duration-200 hover:text-ink hover:bg-line"
          >
            {t('playerAbout')}
          </a>
        </nav>
      </header>

      <DropZone onFile={onFile}>
        <h1
          id="hero-title"
          className="m-0 mb-3 text-4xl font-bold tracking-[-0.02em] text-center"
        >
          {t('playerHeroTitle')}
        </h1>
        <p
          className="m-0 mb-7 text-ink-2 text-base text-center max-w-[420px]"
          dangerouslySetInnerHTML={asHtml(t('playerHeroTagline'))}
        />

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          // transition listens for `translate` (not `transform`) because
          // Tailwind v4's `-translate-y-px` sets the CSS-native
          // `translate` property — NOT `transform: translateY(...)`.
          className="inline-flex items-center gap-2 px-[18px] py-2.5 bg-ink text-bg border border-ink rounded-[10px] font-medium text-[15px] cursor-pointer transition-[translate,background] duration-200 hover:bg-accent hover:border-accent hover:-translate-y-px focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-[3px]"
        >
          <UploadIcon />
          {t('playerBrowse')}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".deck,.zip"
          hidden
          onChange={(e) => {
            const file = e.currentTarget.files?.[0]
            if (file) onFile(file)
            // Reset so picking the same file twice in a row still fires
            // `change`. Without this, browsers skip duplicate selects.
            e.currentTarget.value = ''
          }}
        />

        <p className="mt-3 text-mute text-sm text-center">
          {t('playerBrowseHint')}
        </p>

        <p
          className="text-mute m-0 mt-4 text-sm text-center"
          aria-live="polite"
        >
          {status}
        </p>
        <p
          className="text-[#dc2626] m-0 mt-4 text-sm text-center"
          role="alert"
          aria-live="assertive"
        >
          {error}
        </p>

        <RecentsList onOpen={openRecent} onDelete={handleDelete} />

        <p
          className="mt-8 text-[13px] text-mute text-center"
          dangerouslySetInnerHTML={asHtml(t('playerHeroTip'))}
        />
      </DropZone>

      <Stage
        ref={frameRef}
        active={stageActive}
        onIndicatorClick={() => {
          if (loaderRef.current?.hasActiveDeck) setPaletteOpen((v) => !v)
        }}
      />

      <Palette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onBack={() => {
          routerRef.current?.clearHash()
          loaderRef.current?.close()
        }}
        onOpenDeck={(id) => {
          void openRecent(id)
        }}
      />

      <UndoToast />
    </>
  )
}

function UploadIcon() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="block"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  )
}
