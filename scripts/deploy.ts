#!/usr/bin/env bun
// Deploy `dist/web/` to the `gh-pages` branch on origin.
//
// Builds the public web bundle, copies it into a fresh temp directory,
// initializes a one-commit git repo there, and force-pushes that commit
// to `origin/gh-pages`. The branch is treated as a publish target — its
// history is intentionally overwritten on every deploy.
//
// Usage: ./scripts/deploy.ts [--dry-run]
import { $ } from 'bun'
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'

const repoRoot = path.resolve(import.meta.dirname, '..')
process.chdir(repoRoot)
$.cwd(repoRoot)

const BRANCH = 'gh-pages'

const { values } = parseArgs({
  options: {
    'dry-run': { type: 'boolean' },
    dryrun: { type: 'boolean' },
  },
})
const isDryRun = values['dry-run'] === true || values.dryrun === true

const remoteUrl = (await $`git remote get-url origin`.text()).trim()
if (!remoteUrl) {
  console.error('Error: no `origin` remote configured.')
  process.exit(1)
}

// Capture the source commit before building so the deploy commit message
// points at the exact main-repo state that produced the bundle.
const sourceSha = (await $`git rev-parse --short HEAD`.text()).trim()

console.log('Building web bundle ...')
await $`bun run build:web`

const distDir = path.join(repoRoot, 'dist', 'web')
if (!existsSync(path.join(distDir, 'index.html'))) {
  console.error(`Error: ${path.relative(repoRoot, distDir)}/index.html not found after build.`)
  process.exit(1)
}

// Mint a fresh temp dir per run; reusing one risks mixing in stale files
// (the gh-pages branch is meant to be exactly `dist/web/` and nothing else).
const stage = mkdtempSync(path.join(os.tmpdir(), 'deck-gh-pages-'))
// On dry-run we leave `stage` in place so the user can inspect it.
let cleanup = !isDryRun

try {
  cpSync(distDir, stage, { recursive: true })

  // GitHub Pages runs Jekyll by default, which silently drops files and
  // directories starting with `_`. Vite's output doesn't currently use
  // those, but a single empty .nojekyll is the standard insurance.
  writeFileSync(path.join(stage, '.nojekyll'), '')

  // Bun's `$.cwd()` mutates the global `$` rather than returning a new
  // shell — switch into the staging dir for all git commands below.
  $.cwd(stage)
  await $`git init -q -b ${BRANCH}`
  await $`git add -A`
  const message = `Deploy ${sourceSha} @ ${new Date().toISOString()}`
  await $`git commit -q -m ${message}`

  if (isDryRun) {
    console.log('Dry run: skipping push.')
    console.log(`Staged at: ${stage}`)
    console.log(`Would force-push ${BRANCH} to ${remoteUrl}`)
  } else {
    console.log(`Force-pushing to ${remoteUrl} ${BRANCH} ...`)
    await $`git push --force ${remoteUrl} ${BRANCH}:${BRANCH}`
    console.log(`Deployed ${sourceSha} to ${BRANCH}.`)
  }
} catch (err) {
  // Preserve the stage on failure so the user can debug.
  cleanup = false
  console.error(`Deploy failed; staged tree preserved at: ${stage}`)
  throw err
} finally {
  if (cleanup) {
    rmSync(stage, { recursive: true, force: true })
  }
}
