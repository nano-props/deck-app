import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { useAppStore } from '#/renderer/stores/app.ts'

// Per-deck draft persistence: when the user types something but doesn't
// send, we'd rather not lose it across window close / reopen. Keyed by
// the deck's rootDir (stable across sessions for Sources/Workspaces).
// Cleared on successful send.
const DRAFT_KEY_PREFIX = 'deck:composer-draft:'

function draftKey(rootDir: string): string {
  return DRAFT_KEY_PREFIX + rootDir
}

export function useComposerDraft(): {
  text: string
  /** Same shape as React's useState setter — accepts a value or a
   *  functional update. The functional form is used by send() to avoid
   *  clobbering text the user typed during an in-flight IPC. */
  setText: Dispatch<SetStateAction<string>>
  deckRootDir: string | null
} {
  const deckRootDir = useAppStore((s) => s.deck?.rootDir ?? null)

  const [text, setText] = useState(() => {
    // Hydrate draft synchronously on first render so the textarea
    // starts populated — no flash of empty box.
    if (typeof window === 'undefined') return ''
    const initialDeck = useAppStore.getState().deck?.rootDir
    if (!initialDeck) return ''
    return localStorage.getItem(draftKey(initialDeck)) ?? ''
  })

  // Re-hydrate when the deck changes (Edit pane stays mounted but
  // rootDir flips when the user opens a different deck without closing
  // the window).
  useEffect(() => {
    if (!deckRootDir) return
    const stored = localStorage.getItem(draftKey(deckRootDir)) ?? ''
    setText(stored)
  }, [deckRootDir])

  // Debounce-persist: write 250ms after the last keystroke. Saves IO
  // during fast typing while still landing the latest text quickly.
  // Empty text removes the key so a saved-then-cleared draft doesn't
  // resurrect on next mount.
  //
  // Two effects, on purpose:
  //   - This one schedules the debounced write and only clearTimeout's
  //     on cleanup. An earlier version *also* wrote synchronously in
  //     cleanup, which made the debounce a no-op: every keystroke
  //     re-triggers the effect → cleanup runs → synchronous setItem on
  //     the *previous* text. The debounce timer never fires (always
  //     cleared by the next keystroke), and the user pays a localStorage
  //     write per character.
  //   - The "flush on unmount / deck switch" effect below is the only
  //     one that writes synchronously, with a ref'd latest-text so the
  //     in-flight draft makes it to disk on close.
  const latestTextRef = useRef(text)
  latestTextRef.current = text
  useEffect(() => {
    if (!deckRootDir) return
    const key = draftKey(deckRootDir)
    const timer = setTimeout(() => {
      if (text) localStorage.setItem(key, text)
      else localStorage.removeItem(key)
    }, 250)
    return () => clearTimeout(timer)
  }, [text, deckRootDir])

  // Flush on unmount or deck switch. Cleanup runs once per deckRootDir
  // value change (and on Composer unmount), reading the latest text via
  // a ref so the in-flight debounced value still lands.
  useEffect(() => {
    if (!deckRootDir) return
    const key = draftKey(deckRootDir)
    return () => {
      const t = latestTextRef.current
      if (t) localStorage.setItem(key, t)
      else localStorage.removeItem(key)
    }
  }, [deckRootDir])

  return { text, setText, deckRootDir }
}
