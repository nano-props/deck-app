import { dialog } from 'electron'
import { openDeckInNewWindow } from '#/main/windows.ts'

export async function promptOpenDeck(): Promise<void> {
  const result = await dialog.showOpenDialog({
    title: 'Open .deck',
    filters: [
      { name: 'Deck', extensions: ['deck', 'zip'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  })
  if (result.canceled || result.filePaths.length === 0) return
  const picked = result.filePaths[0]
  if (picked) await openDeckInNewWindow(picked)
}

export async function promptOpenFolder(): Promise<void> {
  const result = await dialog.showOpenDialog({
    title: 'Open deck folder',
    message: 'Pick a folder containing deck.json and index.html',
    properties: ['openDirectory'],
  })
  if (result.canceled || result.filePaths.length === 0) return
  const picked = result.filePaths[0]
  if (picked) await openDeckInNewWindow(picked)
}
