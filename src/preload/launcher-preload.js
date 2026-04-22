// The sibling `src/preload/package.json` (`{"type": "commonjs"}`) exists
// to scope this file as CJS — the repo root is `"type": "module"`, but
// Electron preload in sandbox mode must load as CommonJS (for `require`
// of the `electron` module). Do not delete either file independently.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('deckApp', {
  openDialog: () => ipcRenderer.invoke('deck:open-dialog'),
  openFolder: () => ipcRenderer.invoke('deck:open-folder'),
})
