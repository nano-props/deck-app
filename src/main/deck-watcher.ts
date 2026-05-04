import chokidar, { type FSWatcher } from 'chokidar'
import path from 'node:path'

/**
 * File-watcher for the Editor's live preview.
 *
 * Watches a Deck Source directory and debounces rapid changes into a
 * single `onChange` callback. Covers the "user edits files outside the
 * app" case (VS Code, drag-drop into Finder, git pull) — AI tool writes
 * already have their own `onFileChange` hook wired from tools.ts, so
 * those arrive here too but are idempotent with the coalesce window.
 *
 * Ignore rules:
 *   - dotfiles (`.git`, `.DS_Store`, editor swap files)
 *   - `node_modules` (a Deck Source shouldn't have one, but belt-and-braces)
 *
 * The debounce matters because a "save" in many editors is atomic-rename:
 * write to `.index.html.swp`, rename to `index.html`, unlink the swap.
 * That bursts 2-3 events within a few ms for one logical edit.
 */

export interface DeckWatcher {
  close(): Promise<void>
}

const DEBOUNCE_MS = 120

export function watchDeckSource(rootDir: string, onChange: () => void): DeckWatcher {
  const watcher: FSWatcher = chokidar.watch(rootDir, {
    ignored: (p) => {
      // Chokidar calls the matcher with absolute paths. The root itself
      // should not be ignored, so anchor on path.relative. Paths outside
      // the root (rel starts with '..') won't appear in practice (the
      // watcher is bound to rootDir) but we bail for safety.
      const rel = path.relative(rootDir, p)
      if (!rel || rel.startsWith('..')) return false
      const segments = rel.split(path.sep)
      // Dotfiles at any depth — covers .git, .DS_Store, .vscode, editor swaps.
      if (segments.some((seg) => seg.startsWith('.'))) return true
      if (segments.includes('node_modules')) return true
      return false
    },
    ignoreInitial: true,
    awaitWriteFinish: {
      // Don't fire until the file has stopped growing for this many ms.
      // Larger than DEBOUNCE_MS because some editors stream writes.
      stabilityThreshold: 80,
      pollInterval: 30,
    },
  })

  let timer: NodeJS.Timeout | null = null
  const fire = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      try {
        onChange()
      } catch (err) {
        console.error('[deck-watcher] onChange threw', err)
      }
    }, DEBOUNCE_MS)
  }

  for (const ev of ['add', 'change', 'unlink', 'addDir', 'unlinkDir'] as const) {
    watcher.on(ev, fire)
  }
  watcher.on('error', (err) => {
    // Watcher errors are typically transient (file deleted mid-scan). Log
    // and keep going — chokidar self-recovers from most of these.
    console.warn('[deck-watcher] error', err)
  })

  return {
    close: async () => {
      if (timer) clearTimeout(timer)
      timer = null
      await watcher.close()
    },
  }
}
