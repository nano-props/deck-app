#!/usr/bin/env bun
// Build and package Deck. Defaults to the host platform's target:
//   macOS → Deck.app (via electron-builder's `mac` target)
//   Windows target `win` → portable .exe (cross-buildable from macOS)
// With `install`, moves the resulting macOS app into ~/Applications
// (closing any running instance first). `install` is macOS-only.
//
// Usage: ./scripts/build.ts [install|i|win]
import { $ } from 'bun'
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'

const repoRoot = path.resolve(import.meta.dirname, '..')
process.chdir(repoRoot)
$.cwd(repoRoot)

const APP_NAME = 'Deck'

const { positionals } = parseArgs({ allowPositionals: true })
const mode = positionals[0]
const shouldInstall = mode === 'install' || mode === 'i'
const target: 'mac' | 'win' = mode === 'win' ? 'win' : 'mac'

async function findBuiltArtifact(): Promise<string | null> {
  if (target === 'win') {
    // electron-builder's `portable` target produces a single .exe at the
    // top level of release/. artifactName controls the filename.
    const glob = new Bun.Glob(`release/${APP_NAME}-*-portable.exe`)
    const [match] = await Array.fromAsync(glob.scan({ cwd: repoRoot, onlyFiles: false }))
    return match ? path.join(repoRoot, match) : null
  }
  // mac dir target may emit one directory per declared arch (`mac-arm64`,
  // `mac` for x64). Pick the one matching the host so `install` puts the
  // right binary in ~/Applications.
  const hostDir = process.arch === 'arm64' ? 'mac-arm64' : 'mac'
  const candidate = path.join(repoRoot, 'release', hostDir, `${APP_NAME}.app`)
  return existsSync(candidate) ? candidate : null
}

// Clear any prior build output so `findBuiltArtifact` can't pick up a
// stale artifact if electron-builder fails partway through. A matching
// rm after a successful install is run below.
rmSync(path.join(repoRoot, 'release'), { recursive: true, force: true })

await $`bun install`
await $`bun run typecheck`
// Renderer bundle MUST exist before electron-builder packs it (the
// `files` glob in electron-builder.ts expects `dist/renderer/`).
await $`bun run build:renderer`
await $`bun run build:electron -- --${target}`

const srcApp = await findBuiltArtifact()
if (!srcApp) {
  const what = target === 'win' ? 'portable .exe' : `${APP_NAME}.app`
  console.error(`Error: could not find built ${what} under release/`)
  process.exit(1)
}
console.log(`Built: ${path.relative(repoRoot, srcApp)}`)

if (shouldInstall) {
  if (process.platform !== 'darwin') {
    console.error('install mode is macOS-only')
    process.exit(1)
  }

  console.log(`Installing ${APP_NAME}.app to ~/Applications...`)

  // Imported for side-effects: the module's top-level await quits a
  // running Deck.app (and no-ops on non-macOS).
  await import('./close-app.ts')

  const appsDir = path.join(os.homedir(), 'Applications')
  mkdirSync(appsDir, { recursive: true })
  const destApp = path.join(appsDir, `${APP_NAME}.app`)
  rmSync(destApp, { recursive: true, force: true })
  renameSync(srcApp, destApp)
  console.log(`Installed: ${destApp}`)

  rmSync(path.join(repoRoot, 'release'), { recursive: true, force: true })
  console.log('Done.')
}
