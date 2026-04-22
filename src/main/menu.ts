import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import { promptOpenDeck, promptOpenFolder } from '#/main/dialogs.ts'

const IS_MAC = process.platform === 'darwin'

export function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [...(IS_MAC ? [macAppMenu()] : []), fileMenu(), viewMenu()]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function macAppMenu(): MenuItemConstructorOptions {
  return {
    label: app.name,
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  }
}

function fileMenu(): MenuItemConstructorOptions {
  return {
    label: 'File',
    submenu: [
      {
        label: 'Open .deck…',
        accelerator: 'CmdOrCtrl+O',
        click: () => void promptOpenDeck(),
      },
      {
        label: 'Open Folder…',
        accelerator: 'CmdOrCtrl+Shift+O',
        click: () => void promptOpenFolder(),
      },
      { type: 'separator' },
      IS_MAC ? { role: 'close' } : { role: 'quit' },
    ],
  }
}

function viewMenu(): MenuItemConstructorOptions {
  return {
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  }
}
