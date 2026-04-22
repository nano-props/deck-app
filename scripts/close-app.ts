#!/usr/bin/env bun
// Gracefully quit a running Deck.app, force-killing if it doesn't respond.
// macOS-only (uses AppleScript + pgrep); on other platforms this is a no-op,
// since the install flow it serves only runs on macOS.
import { execFileSync, spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const APP_NAME = 'Deck'

// Match only the packaged binary launched by launchd/Finder. A loose
// pattern like `${APP_NAME}.app` would also match unrelated shells and
// tools whose argv happens to contain the path to Deck.app.
const BINARY_PATH_FRAGMENT = `/${APP_NAME}.app/Contents/MacOS/`

function isRunning(): boolean {
  // pgrep exits 0 when a match is found, 1 when not. Any other code is an
  // actual error (e.g. pgrep missing) — treat as "not running" to avoid
  // blocking the install flow.
  const r = spawnSync('pgrep', ['-f', BINARY_PATH_FRAGMENT], { stdio: 'ignore' })
  return r.status === 0
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin') return
  if (!isRunning()) return

  console.log(`${APP_NAME} is running, attempting graceful quit...`)

  try {
    execFileSync('osascript', ['-e', `quit app "${APP_NAME}"`], { stdio: 'ignore' })
  } catch {
    // osascript may fail if the app just exited; fall through to the wait loop.
  }

  for (let i = 0; i < 10; i++) {
    if (!isRunning()) {
      console.log(`${APP_NAME} quit.`)
      return
    }
    await sleep(500)
  }

  if (isRunning()) {
    console.log(`Forcing ${APP_NAME} to quit...`)
    spawnSync('pkill', ['-9', '-f', BINARY_PATH_FRAGMENT], { stdio: 'ignore' })
    await sleep(1000)
  }
}

await main()
