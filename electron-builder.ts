import type { Configuration } from 'electron-builder'

const config: Configuration = {
  appId: 'com.deck.app',
  productName: 'Deck',
  icon: 'assets/icon.png',
  directories: {
    output: 'release',
  },
  files: ['src/main/**/*.ts', 'src/renderer/**/*', 'src/preload/**/*', 'package.json', '!**/*.map'],
  extraResources: [
    {
      from: 'assets',
      to: 'assets',
      filter: ['**/*'],
    },
  ],
  mac: {
    category: 'public.app-category.productivity',
    target: ['dir'],
    identity: null,
  },
  win: {
    target: [
      { target: 'portable', arch: ['x64'] },
      { target: 'nsis', arch: ['x64'] },
    ],
  },
  portable: {
    artifactName: '${productName}-${version}-portable.exe',
  },
  nsis: {
    artifactName: '${productName}-${version}-setup.${ext}',
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: '${productName}',
  },
  fileAssociations: [
    {
      ext: 'deck',
      name: 'Deck Presentation',
      role: 'Viewer',
    },
  ],
}

export default config
