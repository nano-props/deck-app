// Persists AppWindow bounds across launches.
//
// Lives in `userData/window-state.json` rather than settings.json: bounds
// change at resize/move frequency, and settings.json's serial-queue +
// schema-merge path is overkill (and would also fan out cache reads to
// every settings consumer). Writes here are throttled and atomic
// (writeFile to .tmp + rename), same durability guarantee as settings.
//
// Multi-window model:
//   - Each window has its own `pending` slot keyed by `BaseWindow.id`,
//     so two windows being resized in parallel can't clobber each
//     other's in-flight bounds.
//   - The on-disk file stores a *single* rect — the last one any window
//     wrote. New windows restore from that. This matches the convention
//     of other multi-window editors (VS Code, Sketch): "open a new
//     window like the most-recent one", not "remember every window's
//     individual geometry".

import { app, screen, type Rectangle } from 'electron'
import { existsSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createSerialQueue } from '#/main/util/serial-queue.ts'

export interface WindowState {
  x: number
  y: number
  width: number
  height: number
}

// Hard floors. The BaseWindow already enforces 960×600 via minWidth/
// minHeight, but a saved file could pre-date a future bump or have been
// hand-edited; clamp on the way out so we never restore something the
// shell would immediately resize.
const MIN_W = 960
const MIN_H = 600

// Initial-default sizing: aim for 80% of the work area, but cap so the
// window doesn't feel oversized on a 32" external. The previous
// hardcoded default (1280×820) sits well inside this range, so users on
// typical laptop displays still get the same shape on first run.
const DEFAULT_RATIO = 0.8
const DEFAULT_W_MAX = 1600
const DEFAULT_H_MAX = 1100

// Throttle interval. Resize fires every frame on most platforms;
// coalesce to one disk hit per ~300ms so we don't burn IOPS during a
// drag. The trailing flush at window-close picks up the final value.
const WRITE_INTERVAL_MS = 300

function stateFile(): string {
  return path.join(app.getPath('userData'), 'window-state.json')
}

// Single serialization point for all disk writes. All windows share one
// `.tmp` path and one target file, so two concurrent `writeFile` /
// `rename` pairs would interleave and corrupt the JSON. The queue
// guarantees strict ordering — same pattern as settings.ts.
const { enqueue: enqueueWrite } = createSerialQueue()

let lastSavedOrLoaded: WindowState | null = null

interface PerWindow {
  pending: WindowState | null
  // A single timer per window: leading-edge throttle (start on first
  // update, fire after WRITE_INTERVAL_MS, take whatever pending is at
  // fire time). Subsequent updates within the window only mutate
  // pending, they don't reset the timer — which is what gives us
  // "guaranteed disk hit every 300ms during a long drag" instead of
  // "wait until the user stops".
  timer: NodeJS.Timeout | null
}
const perWindow = new Map<number, PerWindow>()

/** Returns the most recently saved/loaded rect. Null until
 *  `loadWindowState()` resolves at least once. */
export function getCachedWindowState(): WindowState | null {
  return lastSavedOrLoaded
}

export async function loadWindowState(): Promise<WindowState | null> {
  if (lastSavedOrLoaded) return lastSavedOrLoaded
  const file = stateFile()
  if (!existsSync(file)) return null
  try {
    const raw = await readFile(file, 'utf8')
    const parsed = JSON.parse(raw) as Partial<WindowState>
    if (
      typeof parsed.x !== 'number' ||
      typeof parsed.y !== 'number' ||
      typeof parsed.width !== 'number' ||
      typeof parsed.height !== 'number' ||
      !Number.isFinite(parsed.x) ||
      !Number.isFinite(parsed.y) ||
      !Number.isFinite(parsed.width) ||
      !Number.isFinite(parsed.height)
    ) {
      return null
    }
    lastSavedOrLoaded = {
      x: Math.round(parsed.x),
      y: Math.round(parsed.y),
      width: Math.max(MIN_W, Math.round(parsed.width)),
      height: Math.max(MIN_H, Math.round(parsed.height)),
    }
    return lastSavedOrLoaded
  } catch {
    return null
  }
}

// Cascade offset for additional windows. macOS, Windows, and most
// Linux WMs use ~20-30px; 30px is large enough that traffic lights and
// the topbar's first item stay visible behind the new window without
// hiding the previous one entirely.
const CASCADE_OFFSET_PX = 30

/**
 * Resolve initial BaseWindow bounds. If `prev` covers a still-connected
 * display, return it verbatim. Otherwise compute a sensible default
 * centered on the primary display. When `cascadeIndex > 0` (i.e. this
 * is the Nth AppWindow), shift the result diagonally so a New Window
 * doesn't land exactly on top of the existing one.
 *
 * Multi-display safety: a saved rect can land entirely off-screen if the
 * user disconnected the monitor it was on, or moved the dock between
 * displays. `screen.getDisplayMatching` returns the display whose
 * workArea overlaps the rect most; we then check the rect's center
 * lands inside that display's work area before trusting it.
 */
export function resolveInitialBounds(
  prev: WindowState | null,
  cascadeIndex = 0,
): {
  width: number
  height: number
  x?: number
  y?: number
} {
  const restored = prev && isOnscreen(prev) ? prev : null
  if (cascadeIndex <= 0) {
    return restored
      ? { x: restored.x, y: restored.y, width: restored.width, height: restored.height }
      : centeredDefault()
  }
  // Cascade: shift the restored position diagonally so a New Window
  // doesn't land on top of the existing one. If the shifted rect would
  // run off-screen, fall back to centered defaults — *not* to the
  // restored position, which would just re-stack every cascade attempt
  // at the same spot.
  if (restored) {
    const shift = CASCADE_OFFSET_PX * cascadeIndex
    const shifted: WindowState = {
      x: restored.x + shift,
      y: restored.y + shift,
      width: restored.width,
      height: restored.height,
    }
    if (isOnscreen(shifted)) return shifted
  }
  return centeredDefault()
}

function centeredDefault(): { width: number; height: number } {
  const work = screen.getPrimaryDisplay().workAreaSize
  return {
    width: clamp(Math.round(work.width * DEFAULT_RATIO), MIN_W, DEFAULT_W_MAX),
    height: clamp(Math.round(work.height * DEFAULT_RATIO), MIN_H, DEFAULT_H_MAX),
  }
}

function isOnscreen(rect: WindowState): boolean {
  const candidate: Rectangle = {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  }
  const display = screen.getDisplayMatching(candidate)
  const work = display.workArea
  // Center-point check rather than overlap-area: strict-overlap
  // thresholds get fiddly across DPRs / partial off-screen drags, and
  // the practical failure we care about is "window stranded on an
  // unplugged monitor", which a center check catches reliably.
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  return cx >= work.x && cx <= work.x + work.width && cy >= work.y && cy <= work.y + work.height
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function slot(windowId: number): PerWindow {
  let s = perWindow.get(windowId)
  if (!s) {
    s = { pending: null, timer: null }
    perWindow.set(windowId, s)
  }
  return s
}

/**
 * Schedule a throttled write for one window's bounds. Concurrent
 * resizes across windows each get their own pending slot, so they
 * never clobber each other.
 */
export function saveWindowState(windowId: number, state: WindowState): void {
  const s = slot(windowId)
  const rounded: WindowState = {
    x: Math.round(state.x),
    y: Math.round(state.y),
    width: Math.round(state.width),
    height: Math.round(state.height),
  }
  s.pending = rounded
  // Update the in-memory pointer immediately so a New Window opened
  // mid-drag (before the throttle fires / disk lands) inherits the
  // current rect rather than the previous on-disk one.
  lastSavedOrLoaded = rounded
  if (s.timer) return
  s.timer = setTimeout(() => {
    s.timer = null
    void flushSlot(windowId)
  }, WRITE_INTERVAL_MS)
}

// Promises registered by close-handlers so before-quit can await them.
// fire-and-forget at close would otherwise race app.exit(): writeFile +
// rename can be cut off mid-flight, losing the last user-sized bounds.
const inFlightFlushes = new Set<Promise<void>>()

/** Wait for every flushWindowState started but not yet resolved.
 *  Called from before-quit so the final bounds always reach disk. */
export async function awaitAllWindowStateFlushes(): Promise<void> {
  if (inFlightFlushes.size === 0) return
  await Promise.all([...inFlightFlushes])
}

/**
 * Force any pending write for a window to disk and forget the slot.
 * Call from the window's `close` event so the last drag before quit
 * isn't lost to the throttle timer.
 */
export function flushWindowState(windowId: number): Promise<void> {
  const promise = doFlush(windowId)
  inFlightFlushes.add(promise)
  void promise.finally(() => inFlightFlushes.delete(promise))
  return promise
}

async function doFlush(windowId: number): Promise<void> {
  const s = perWindow.get(windowId)
  if (!s) return
  if (s.timer) {
    clearTimeout(s.timer)
    s.timer = null
  }
  // Drain pending. In practice this loops at most twice: once for the
  // bounds the timer would have written, and once if a stray save
  // landed while flushSlot was awaiting the serial queue. The cap
  // protects against a stuck disk error where flushSlot swallows the
  // throw and leaves pending intact — better to leak the slot than
  // hang shutdown.
  for (let i = 0; i < 3 && s.pending; i++) await flushSlot(windowId)
  perWindow.delete(windowId)
}

async function flushSlot(windowId: number): Promise<void> {
  const s = perWindow.get(windowId)
  if (!s || !s.pending) return
  const snapshot = s.pending
  await enqueueWrite(async () => {
    const file = stateFile()
    const tmp = file + '.tmp'
    try {
      await writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8')
      await rename(tmp, file)
      // Only clear pending after the rename lands. If the write threw
      // mid-way the slot still holds the latest bounds, and the next
      // saveWindowState call (or close-flush) will retry.
      // (Don't reassign `lastSavedOrLoaded` here — saveWindowState is
      // its sole writer, and may have advanced it past `snapshot`
      // while we were awaiting the queue.)
      if (s.pending === snapshot) s.pending = null
    } catch (err) {
      console.warn('[window-state] write failed', err)
    }
  })
}
