import { dialog, shell } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import type { AppWindow } from '#/main/app-window.ts'
import { unpackDeckTo } from '#/main/deck-loader.ts'
import { packDeck } from '#/main/deck-packer.ts'
import { createDeckFromTemplate } from '#/main/skills.ts'
import { clearWorkspace, ensureWorkspaceDir, resolveWorkspaceForPack } from '#/main/workspaces.ts'

export async function promptOpenDeck(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: 'Open .deck',
    filters: [
      { name: 'Deck', extensions: ['deck', 'zip'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0] ?? null
}

export async function promptOpenFolder(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: 'Open deck folder',
    message: 'Pick a folder containing deck.json and index.html',
    properties: ['openDirectory'],
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0] ?? null
}

/**
 * Unpack a Deck Pack into its app-managed workspace, then load that
 * workspace into `win` in editor mode.
 *
 * The workspace directory is keyed by the Pack's SHA-256 (see
 * workspaces.ts), so opening the same Pack twice resolves to the same
 * directory and preserves earlier edits. Behavior by workspace state:
 *
 *   - fresh:    unpack silently, open.
 *   - reusable: ask the user — "Continue Editing" (reuse), "Start Fresh"
 *               (wipe + re-unpack), or "Cancel".
 *   - broken:   treat as fresh after wiping — there's nothing user-authored
 *               left to protect.
 */
export async function unpackAndOpenInEditor(zipPath: string, win: AppWindow, deckName?: string): Promise<void> {
  let resolution: Awaited<ReturnType<typeof resolveWorkspaceForPack>>
  try {
    resolution = await resolveWorkspaceForPack(zipPath, deckName)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    void dialog.showMessageBox({
      type: 'error',
      title: 'Failed to open deck',
      message: 'Failed to locate edit workspace',
      detail: `${message}\n\nPack: ${zipPath}`,
    })
    return
  }

  const { dir, state } = resolution
  let needsUnpack: boolean

  if (state === 'reusable') {
    const choice = await dialog.showMessageBox(win.getBaseWindow(), {
      type: 'question',
      title: 'Resume editing?',
      message: 'This pack has a work-in-progress copy',
      detail:
        `You've edited "${deckName || path.parse(zipPath).name}" from this pack before. ` +
        'Continue with those edits, or start fresh from the pack?',
      buttons: ['Continue Editing', 'Start Fresh', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
    })
    if (choice.response === 2) return
    needsUnpack = choice.response === 1
    if (needsUnpack) await clearWorkspace(dir)
  } else if (state === 'broken') {
    await clearWorkspace(dir)
    needsUnpack = true
  } else {
    needsUnpack = true
  }

  const createdByUs = !existsSync(dir)
  try {
    await ensureWorkspaceDir(dir)
    if (needsUnpack) await unpackDeckTo(zipPath, dir)
  } catch (err) {
    if (createdByUs) await rm(dir, { recursive: true, force: true }).catch(() => {})
    const message = err instanceof Error ? err.message : String(err)
    void dialog.showMessageBox({
      type: 'error',
      title: 'Failed to unpack deck',
      message: 'Failed to unpack deck',
      detail: `${message}\n\nPack: ${zipPath}`,
    })
    return
  }

  await win.openDeck(dir, 'edit', 'workspace')
}

/**
 * "+ New deck" flow: ask for a name, ask where to put it, copy the
 * starter template, open the new Source in `win` in edit mode.
 *
 * This is driven by two sequential dialogs because Electron doesn't have
 * a "name + save-as" composite picker. The friction is acceptable for a
 * one-time create action.
 */
export async function createNewDeckInWindow(win: AppWindow): Promise<void> {
  const save = await dialog.showSaveDialog({
    title: 'Create new deck',
    message: 'Pick where to save the new Deck Source directory',
    defaultPath: path.join(process.env.HOME || '', 'my-deck'),
    buttonLabel: 'Create',
    properties: ['createDirectory'],
  })
  if (save.canceled || !save.filePath) return

  const destDir = save.filePath
  const baseName = path.basename(destDir)

  if (existsSync(destDir)) {
    void dialog.showMessageBox({
      type: 'error',
      title: 'Path already exists',
      message: `"${baseName}" already exists`,
      detail: 'Pick a different name or delete the existing path first.',
    })
    return
  }

  try {
    await createDeckFromTemplate({ destDir, name: baseName })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    void dialog.showMessageBox({
      type: 'error',
      title: 'Failed to create deck',
      message: 'Failed to create deck',
      detail: `${message}\n\nTarget: ${destDir}`,
    })
    // Best-effort cleanup if we partially wrote.
    await rm(destDir, { recursive: true, force: true }).catch(() => {})
    return
  }

  await win.openDeck(destDir, 'edit')
}

/**
 * Prompt the user for a destination `.deck` path, then pack the window's
 * current Deck Source into it.
 *
 * No-op for Deck Packs (kind: 'pack') — a Pack is already packed, and the
 * temp extraction it's backed by is not the authoritative source. Surfaces
 * an info dialog so the user isn't confused by a silent no-op.
 */
export async function exportCurrentDeckAsPack(win: AppWindow): Promise<void> {
  const deck = win.getDeck()
  if (!deck) return
  if (deck.kind === 'pack') {
    void dialog.showMessageBox({
      type: 'info',
      title: 'Already packed',
      message: 'This deck is already a .deck pack.',
      detail: 'Export is only needed for Deck Sources (unpacked directories).',
    })
    return
  }

  // Suggest `<sourceDirName>.deck` next to the Source as the default.
  const parsed = path.parse(deck.rootDir)
  const defaultName = `${parsed.base || deck.manifest.name || 'deck'}.deck`
  const defaultPath = path.join(parsed.dir || parsed.root, defaultName)

  const save = await dialog.showSaveDialog(win.getBaseWindow(), {
    title: 'Export Deck Pack',
    message: 'Save the current Deck Source as a .deck pack',
    defaultPath,
    filters: [{ name: 'Deck', extensions: ['deck'] }],
    buttonLabel: 'Export',
  })
  if (save.canceled || !save.filePath) return
  // macOS auto-appends the extension from `filters`; Windows/Linux don't.
  // Normalize so users who typed "my-deck" don't end up with a file the
  // Player can't auto-detect by extension.
  const destPath = save.filePath.toLowerCase().endsWith('.deck') ? save.filePath : `${save.filePath}.deck`

  try {
    const result = await packDeck(deck.rootDir, destPath)
    const response = await dialog.showMessageBox(win.getBaseWindow(), {
      type: 'info',
      title: 'Exported',
      message: `Exported ${result.fileCount} files as .deck`,
      detail: `${path.basename(result.destPath)} · ${formatBytes(result.bytes)}\n\n${result.destPath}`,
      buttons: ['OK', process.platform === 'darwin' ? 'Show in Finder' : 'Show in Folder'],
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
      title: 'Export failed',
      message: 'Could not export the Deck Pack',
      detail: message,
    })
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
