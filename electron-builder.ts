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
    // electron-builder organizes builds by arch, so any `dir` here would be
    // emitted for every arch declared on dmg. `build.ts install` picks the
    // host-arch directory out of `release/mac*/` itself.
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'dir', arch: ['arm64', 'x64'] },
    ],
    identity: null,
    // Force arch into the filename on every build. electron-builder's default
    // omits the arch suffix on x64, which would make `Deck-0.1.1.dmg` (intel)
    // and `Deck-0.1.1-arm64.dmg` (apple silicon) sort next to each other in
    // releases with no hint of which is which.
    artifactName: '${productName}-${version}-${arch}.${ext}',
  },
  // Windows: portable .exe only. The build script (scripts/build.ts) globs
  // for the portable artifact specifically — adding an NSIS installer here
  // without wiring it through the build script would silently produce a
  // second unreleased binary on every Windows build.
  win: {
    target: [{ target: 'portable', arch: ['x64'] }],
  },
  portable: {
    artifactName: '${productName}-${version}-${arch}-portable.exe',
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
