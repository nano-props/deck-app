#!/usr/bin/env bun
// Publish a GitHub release for Deck. Builds macOS (.dmg for arm64 and x64)
// and Windows (portable .exe x64), tags the current commit with the
// package.json version, and uploads every artifact via `gh release create`.
//
// Usage: ./scripts/publish.ts [dryrun|--dryrun|--dry-run] [--proxy http://127.0.0.1:7890]
import { $ } from 'bun'
import { mkdirSync, renameSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

const repoRoot = path.resolve(import.meta.dirname, '..')
process.chdir(repoRoot)
$.cwd(repoRoot)

const APP_NAME = 'Deck'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    proxy: { type: 'string' },
    dryrun: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
  },
})
const isDryRun =
  values.dryrun === true ||
  values['dry-run'] === true ||
  positionals.includes('dryrun') ||
  positionals.includes('dry-run')

if (values.proxy) {
  for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY']) {
    process.env[k] = values.proxy
  }
  console.log(`Using proxy: ${values.proxy}`)
}

if (isDryRun) {
  console.log('Dry run: building artifacts only; skipping git tag, git push, and GitHub release upload.')
}

const { version } = (await Bun.file(path.join(repoRoot, 'package.json')).json()) as {
  version: string
}
const tag = `v${version}`

// Refuse to publish from a dirty tree — the tag should point at a known commit.
if (!isDryRun && (await $`git status --porcelain`.text()).trim() !== '') {
  console.error('Error: working directory is not clean. Commit or stash changes first.')
  process.exit(1)
}

// Refuse to overwrite an existing tag. Bumping requires a package.json change.
if (!isDryRun && (await $`git rev-parse ${tag}`.quiet().nothrow()).exitCode === 0) {
  console.error(`Error: tag ${tag} already exists. Bump version in package.json first.`)
  process.exit(1)
}

async function findOne(pattern: string, what: string): Promise<string> {
  const glob = new Bun.Glob(pattern)
  const [match] = await Array.fromAsync(glob.scan({ cwd: repoRoot, onlyFiles: false }))
  if (!match) {
    console.error(`Error: ${what} not found under release/ (pattern: ${pattern}).`)
    process.exit(1)
  }
  return path.join(repoRoot, match)
}

async function findAll(pattern: string, what: string, expected: number): Promise<string[]> {
  const glob = new Bun.Glob(pattern)
  const matches = (await Array.fromAsync(glob.scan({ cwd: repoRoot, onlyFiles: false })))
    .map((m) => path.join(repoRoot, m))
    .sort()
  if (matches.length !== expected) {
    console.error(
      `Error: expected ${expected} ${what} under release/ (pattern: ${pattern}), found ${matches.length}.`,
    )
    process.exit(1)
  }
  return matches
}

// Stash artifacts outside `release/` between builds — `scripts/build.ts`
// wipes `release/` on every invocation, so the mac products would not
// survive the windows build otherwise.
const stash = path.join(repoRoot, 'release-publish')
await $`rm -rf ${stash}`
mkdirSync(stash, { recursive: true })

try {
  console.log(`Building ${tag} (macOS) ...`)
  await $`bun scripts/build.ts`

  // Two dmgs (arm64 + x64) per electron-builder.ts mac.target config.
  const dmgSrcs = await findAll(`release/${APP_NAME}-${version}-*.dmg`, `${APP_NAME} .dmg`, 2)
  const dmgs = dmgSrcs.map((src) => {
    const dest = path.join(stash, path.basename(src))
    renameSync(src, dest)
    return dest
  })

  console.log(`Building ${tag} (Windows) ...`)
  await $`bun scripts/build.ts win`

  const exeSrc = await findOne(`release/${APP_NAME}-*-portable.exe`, `${APP_NAME} portable .exe`)
  const exe = path.join(stash, path.basename(exeSrc))
  renameSync(exeSrc, exe)

  if (isDryRun) {
    await $`rm -rf release`
    mkdirSync(path.join(repoRoot, 'release'), { recursive: true })
    const artifacts = [...dmgs, exe].map((src) => {
      const dest = path.join(repoRoot, 'release', path.basename(src))
      renameSync(src, dest)
      return dest
    })
    console.log('Dry run complete. Artifacts:')
    for (const artifact of artifacts) {
      console.log(`- ${path.relative(repoRoot, artifact)}`)
    }
  } else {
    await $`git tag -a ${tag} -m ${`Release ${tag}`}`
    await $`git push origin ${tag}`

    // Builds are unsigned. Without these notes Gatekeeper/SmartScreen
    // will block the download and users will assume the app is broken.
    const notes = [
      `Unsigned builds.`,
      ``,
      `**macOS** — after installing, run:`,
      '```sh',
      `xattr -dr com.apple.quarantine /Applications/${APP_NAME}.app`,
      '```',
      `Or right-click the app → **Open** → **Open**.`,
      ``,
      `**Windows** — SmartScreen → **More info** → **Run anyway**.`,
    ].join('\n')

    console.log(`Creating GitHub release ${tag} ...`)
    try {
      await $`gh release create ${tag} ${dmgs} ${exe} --title ${tag} --notes ${notes}`
    } catch (err) {
      // The release didn't get created — leaving the tag in place orphans it.
      // Roll back the remote tag and the local tag so the next attempt isn't
      // blocked by "tag already exists" and so the upstream history doesn't
      // collect dangling tags pointing at unreleased commits.
      console.error('gh release create failed; rolling back tag.')
      await $`git push origin :refs/tags/${tag}`.nothrow()
      await $`git tag -d ${tag}`.nothrow()
      throw err
    }

    await $`rm -rf release`
    console.log(`Published ${tag}`)
  }
} finally {
  // Always clean the stash, even on failure — a leftover `release-publish/`
  // would not block the next attempt, but it would silently mix prior-run
  // artifacts into the next publish if anything ever read from it.
  await $`rm -rf ${stash}`
}
