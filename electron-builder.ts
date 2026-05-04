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
    // Skills are loaded at runtime (inlined into AI system prompt, and
    // templates copied on "New deck"). Ship them as external resources so
    // they can be updated without code changes in packaged builds.
    {
      from: 'skills',
      to: 'skills',
      filter: ['**/*.md', '**/*.html', '**/*.json'],
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
