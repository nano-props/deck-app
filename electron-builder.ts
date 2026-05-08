import type { Configuration } from 'electron-builder'

const config: Configuration = {
  appId: 'com.deck.app',
  productName: 'Deck',
  icon: 'assets/icon.png',
  directories: {
    output: 'release',
  },
  files: [
    'src/main/**/*.ts',
    'src/preload/**/*',
    // Vite-built renderer bundle. Ship the bundle, not the source —
    // `dist/renderer/` is what `CHROME_HTML` points at.
    'dist/renderer/**/*',
    'package.json',
    '!**/*.map',
  ],
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
  // Windows: portable .exe only. The publish flow is macOS-only today,
  // and the build script (scripts/build.ts) globs for the portable
  // artifact specifically — adding an NSIS installer here without
  // wiring it through the build script would silently produce a second
  // unreleased binary on every Windows build.
  win: {
    target: [{ target: 'portable', arch: ['x64'] }],
  },
  portable: {
    artifactName: '${productName}-${version}-portable.exe',
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
