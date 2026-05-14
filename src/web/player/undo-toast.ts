// Imperative undo-toast singleton.
//
// One toast at a time. Showing a new toast while another is visible
// commits (no-undo) the previous one — matching Gmail's pattern, and
// importantly preserving the "user deletes A, then B before A's timer
// fires" behavior: A is committed BEFORE B replaces it on screen, so
// the on-disk delete actually runs.
//
// React subscribers consume this via a zustand-flavored snapshot. It's
// not a true zustand store because the toast also owns a timer and
// progress-bar reset that has to fire imperatively — encoding that in
// the store body would muddle the surface. Instead the store is a thin
// reactive surface that components subscribe to for `current`; the
// imperative `show/undo/commit` operations live on the singleton.

import { useSyncExternalStore } from 'react'

export const TOAST_TIMEOUT_MS = 6000

export interface ToastSpec {
  message: string
  onUndo: () => void
  onCommit: () => void
}

class ToastController {
  private current: ToastSpec | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  /** Bumped whenever React subscribers should re-read `current`. */
  private version = 0
  private listeners = new Set<() => void>()
  /** True if onCommit already fired for the current spec — guards
   *  against the timer racing with a manual `commit()` call. */
  private committedFlag = false

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  getSnapshot = (): { spec: ToastSpec | null; version: number } => {
    // Same identity until version bumps — useSyncExternalStore needs a
    // stable reference between unrelated re-renders.
    return this.snapshot
  }

  private snapshot: { spec: ToastSpec | null; version: number } = {
    spec: null,
    version: 0,
  }

  private notify(): void {
    this.version++
    this.snapshot = { spec: this.current, version: this.version }
    for (const l of this.listeners) l()
  }

  show(spec: ToastSpec): void {
    if (this.current) this.commit()
    this.current = spec
    this.committedFlag = false
    this.timer = setTimeout(() => this.commit(), TOAST_TIMEOUT_MS)
    this.notify()
  }

  undo(): void {
    if (!this.current) return
    const spec = this.current
    this.cleanup()
    spec.onUndo()
  }

  commit(): void {
    if (!this.current || this.committedFlag) return
    const spec = this.current
    this.committedFlag = true
    this.cleanup()
    spec.onCommit()
  }

  private cleanup(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.current = null
    this.notify()
  }
}

export const toast = new ToastController()

export function useToast(): ToastSpec | null {
  const snap = useSyncExternalStore(toast.subscribe, toast.getSnapshot, () => ({
    spec: null,
    version: 0,
  }))
  return snap.spec
}
