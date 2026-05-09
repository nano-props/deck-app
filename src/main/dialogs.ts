import { app, dialog, shell } from 'electron'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AppWindow } from '#/main/app-window/index.ts'
import { packDeck } from '#/main/deck-packer.ts'
import { t } from '#/main/i18n/index.ts'
import { createDeckFromTemplate } from '#/main/skills.ts'

export async function promptOpenDeck(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: t('dialog.openDeck.title'),
    filters: [
      { name: 'Deck', extensions: ['deck', 'zip'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0] ?? null
}

/**
 * "+ New deck" flow: ask where to save a new `.deck` file, write the
 * starter template into a tmpdir, pack it into the chosen path, then
 * open the result in `win` in edit mode.
 *
 * Producing a single `.deck` file (rather than a bare directory) keeps
 * the user-visible artifact aligned with Save As and hides the Source/
 * folder concept from the default UX.
 */
export async function createNewDeckInWindow(win: AppWindow): Promise<void> {
  // `app.getPath('home')` is cross-platform (USERPROFILE on Windows,
  // HOME on POSIX). The earlier `process.env.HOME || ''` fallback would
  // have produced a relative path on Windows, where HOME is typically
  // unset — the dialog would land in an unpredictable cwd.
  const save = await dialog.showSaveDialog({
    title: t('dialog.newDeck.title'),
    message: t('dialog.newDeck.message'),
    defaultPath: path.join(app.getPath('home'), 'my-deck.deck'),
    filters: [{ name: 'Deck', extensions: ['deck'] }],
    buttonLabel: t('dialog.newDeck.button'),
  })
  if (save.canceled || !save.filePath) return

  // macOS auto-appends the extension from `filters`; Windows/Linux don't.
  const destPath = save.filePath.toLowerCase().endsWith('.deck') ? save.filePath : `${save.filePath}.deck`
  const baseName = path.parse(destPath).name

  // Stage the template in a tmpdir, then pack to destPath. Using a
  // tmpdir (instead of writing the template next to destPath) keeps
  // failures atomic — if pack fails, the user's chosen path is never
  // touched.
  const stageDir = await mkdtemp(path.join(os.tmpdir(), 'deck-new-'))
  try {
    await createDeckFromTemplate({ destDir: stageDir, name: baseName })
    await packDeck(stageDir, destPath)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    void dialog.showMessageBox({
      type: 'error',
      title: t('dialog.failedToCreate.title'),
      message: t('dialog.failedToCreate.message'),
      detail: `${message}\n\nTarget: ${destPath}`,
    })
    return
  } finally {
    await rm(stageDir, { recursive: true, force: true }).catch(() => {})
  }

  await win.openDeck(destPath, 'edit')
}

/**
 * Save the current deck.
 *
 * - Pack:   rezip the live extraction (rootDir) back into the original
 *           `.deck` file the user opened (sourcePath). No dialog.
 * - Source: nothing to flush — Source edits already live on disk in
 *           the user's directory. Returns true silently.
 *
 * Missing-source-file handling: if the original `.deck` was deleted
 * out from under us mid-edit, we must NOT silently swallow that — the
 * tmpdir is the only copy of the user's work. Behavior:
 *   - silent (close-time): pack to a sibling `<original>.recovered.deck`
 *     so the data survives even though we can't reach the user. The
 *     console gets a warning and `markClean` is NOT called (the rezip
 *     didn't land at sourcePath).
 *   - interactive: prompt "the original file is gone — Save As?" and
 *     route through the user-driven Save As flow.
 *
 * Errors surface a dialog (unless `silent`). Returns true on success.
 */
export async function saveDeckInWindow(win: AppWindow, opts?: { silent?: boolean }): Promise<boolean> {
  const deck = win.getDeck()
  if (!deck) return false
  if (deck.kind === 'source') return true

  // Pre-flight: original `.deck` still where we expect it?
  if (!existsSync(deck.sourcePath)) {
    if (opts?.silent) {
      // Last-resort save to a sibling path so tmpdir teardown doesn't
      // erase the user's work. Don't markClean — sourcePath is still
      // missing, so the deck IS still effectively dirty against its
      // identity. The recovery file is the rescue, not the new home.
      const recoveryPath = `${deck.sourcePath}.recovered.deck`
      try {
        await packDeck(deck.rootDir, recoveryPath)
        console.warn(
          `[deck] original .deck missing on close (${deck.sourcePath}); ` + `wrote recovery copy to ${recoveryPath}`,
        )
        return true
      } catch (err) {
        console.error('[deck] recovery save failed', err)
        return false
      }
    }
    // Interactive path — tell the user, offer Save As.
    const choice = await dialog.showMessageBox(win.getBaseWindow(), {
      type: 'warning',
      title: t('dialog.sourceMissing.title'),
      message: t('dialog.sourceMissing.message'),
      detail: t('dialog.sourceMissing.detail', { path: deck.sourcePath }),
      buttons: [t('dialog.sourceMissing.saveAs'), t('dialog.cancel')],
      defaultId: 0,
      cancelId: 1,
    })
    if (choice.response === 0) {
      await saveDeckAsInWindow(win)
    }
    return false
  }

  try {
    await packDeck(deck.rootDir, deck.sourcePath)
    win.markClean()
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!opts?.silent) {
      void dialog.showMessageBox(win.getBaseWindow(), {
        type: 'error',
        title: t('dialog.saveFailed.title'),
        message: t('dialog.saveFailed.message'),
        detail: message,
      })
    }
    return false
  }
}

/**
 * "Save As .deck…" — pack the current deck's contents into a user-chosen
 * `.deck` file. Works on both Pack and Source. Does NOT change which
 * file the window is editing — that stays as the original sourcePath.
 * (To switch to the new file, the user reopens it.)
 */
export async function saveDeckAsInWindow(win: AppWindow): Promise<void> {
  const deck = win.getDeck()
  if (!deck) return

  // Default name: derive from sourcePath. For a Pack, drop the .deck
  // extension on the basename so we don't suggest `foo.deck.deck`.
  const parsed = path.parse(deck.sourcePath)
  const baseName = parsed.ext.toLowerCase() === '.deck' ? parsed.name : parsed.base || deck.manifest.name || 'deck'
  const defaultName = `${baseName}.deck`
  // Prefer the deck's own dir/root; fall back to the user's home (cross
  // -platform via Electron, unlike `process.env.HOME` which is unset on
  // Windows). Final '' fallback only fires if `app.getPath('home')`
  // itself errored, which Electron makes very unlikely.
  const defaultDir = parsed.dir || parsed.root || app.getPath('home')
  const defaultPath = path.join(defaultDir, defaultName)

  const save = await dialog.showSaveDialog(win.getBaseWindow(), {
    title: t('dialog.saveAs.title'),
    message: t('dialog.saveAs.message'),
    defaultPath,
    filters: [{ name: 'Deck', extensions: ['deck'] }],
    buttonLabel: t('dialog.saveAs.button'),
  })
  if (save.canceled || !save.filePath) return
  // macOS auto-appends the extension from `filters`; Windows/Linux don't.
  const destPath = save.filePath.toLowerCase().endsWith('.deck') ? save.filePath : `${save.filePath}.deck`

  try {
    const result = await packDeck(deck.rootDir, destPath)
    const response = await dialog.showMessageBox(win.getBaseWindow(), {
      type: 'info',
      title: t('dialog.saved.title'),
      message: t('dialog.saved.message', { count: result.fileCount }),
      detail: `${path.basename(result.destPath)} · ${formatBytes(result.bytes)}\n\n${result.destPath}`,
      buttons: [
        t('dialog.ok'),
        process.platform === 'darwin' ? t('dialog.saved.showInFinder') : t('dialog.saved.showInFolder'),
      ],
      defaultId: 0,
      cancelId: 0,
    })
    if (response.response === 1) {
      shell.showItemInFolder(result.destPath)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    void dialog.showMessageBox(win.getBaseWindow(), {
      type: 'error',
      title: t('dialog.saveFailed.title'),
      message: t('dialog.saveFailed.message'),
      detail: message,
    })
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
