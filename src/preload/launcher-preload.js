// The sibling `src/preload/package.json` (`{"type": "commonjs"}`) exists
// to scope this file as CJS — the repo root is `"type": "module"`, but
// Electron preload in sandbox mode must load as CommonJS (for `require`
// of the `electron` module). Do not delete either file independently.
const { contextBridge, ipcRenderer, webUtils } = require('electron')

// Tag the document so CSS can avoid the Windows/Linux title bar overlay
// (a 32px strip with native min/max/close buttons pinned top-right).
if (process.platform !== 'darwin') {
  window.addEventListener('DOMContentLoaded', () => {
    document.documentElement.setAttribute('data-chrome', 'overlay')
  })
}

contextBridge.exposeInMainWorld('deckApp', {
  openDialog: () => ipcRenderer.invoke('deck:open-dialog'),
  openFolder: () => ipcRenderer.invoke('deck:open-folder'),
  // Dropped File objects don't carry `.path` in modern Electron — the
  // absolute path has to be pulled out of `webUtils` on the preload side
  // and handed back over IPC as a plain string.
  openDroppedFile: (file) => ipcRenderer.invoke('deck:open-path', webUtils.getPathForFile(file)),
  setChromeTheme: (theme) => ipcRenderer.invoke('deck:set-chrome-theme', theme),
})
