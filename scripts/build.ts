#!/usr/bin/env bun
// Build and package Deck.app. With `install`, moves the resulting app
// into ~/Applications (closing any running instance first).
//
// Usage: ./scripts/build.ts [install|i]
import { spawnSync } from 'node:child_process'
import { globSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'

const repoRoot = path.resolve(import.meta.dirname, '..')
process.chdir(repoRoot)

const APP_NAME = 'Deck'

const { positionals } = parseArgs({ allowPositionals: true })
const mode = positionals[0]
const shouldInstall = mode === 'install' || mode === 'i'

function run(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: false })
  if (r.status !== 0) {
    console.error(`command failed: ${cmd} ${args.join(' ')}`)
    process.exit(r.status ?? 1)
  }
}

function findBuiltApp(): string | null {
  // electron-builder picks the output dir based on arch: `mac-arm64` on
  // Apple Silicon, `mac` / `mac-x64` on Intel. Let glob find whatever
  // actually got produced.
  const [match] = globSync(`release/mac*/${APP_NAME}.app`, { cwd: repoRoot })
  return match ? path.join(repoRoot, match) : null
}

// Clear any prior build output so `findBuiltApp` can't pick up a stale
// artifact if electron-builder fails partway through. A matching rm after
// a successful install is run below.
rmSync(path.join(repoRoot, 'release'), { recursive: true, force: true })

run('bun', ['install'])
run('bun', ['run', 'typecheck'])
run('bun', ['run', 'build:electron'])

const srcApp = findBuiltApp()
if (!srcApp) {
  console.error(`Error: could not find built ${APP_NAME}.app under release/`)
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
