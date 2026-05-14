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
import { Command, Upload } from 'lucide-react'
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

      {stageActive && (
        <button
          type="button"
          onClick={() => setPaletteOpen((v) => !v)}
          aria-label={t('paletteOpenButton')}
          title={t('paletteOpenButton')}
          // text-white is intentional — the deck iframe's backdrop is
          // not theme-aware, so a white glyph + dark drop-shadow halo
          // is the only combo that stays legible on both light and
          // dark deck backgrounds. top-16 leaves room for chapter
          // labels that anchor near the top of the deck.
          className="group fixed right-6 top-16 z-[60] w-9 h-9 flex items-center justify-center bg-transparent border-0 p-0 cursor-pointer text-white opacity-70 hover:opacity-100 drop-shadow-[0_1px_2px_rgb(0_0_0/0.55)] transition-opacity duration-150 focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
        >
          <Command
            size={18}
            strokeWidth={1.8}
            className="transition-transform duration-150 ease-out group-hover:scale-110"
          />
        </button>
      )}

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
          <Upload size={16} strokeWidth={2} aria-hidden />
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

      <Stage ref={frameRef} active={stageActive} />

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
