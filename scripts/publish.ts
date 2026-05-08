#!/usr/bin/env bun
// Publish a GitHub release for Deck. Builds the macOS .app, tars it, tags
// the current commit with the package.json version, and uploads the tarball
// via `gh release create`.
//
// Usage: ./scripts/publish.ts [--proxy http://127.0.0.1:7890]
import { $ } from 'bun'
import path from 'node:path'
import { parseArgs } from 'node:util'

const repoRoot = path.resolve(import.meta.dirname, '..')
process.chdir(repoRoot)
$.cwd(repoRoot)

const APP_NAME = 'Deck'

const { values } = parseArgs({
  options: { proxy: { type: 'string' } },
})

if (values.proxy) {
  for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY']) {
    process.env[k] = values.proxy
  }
  console.log(`Using proxy: ${values.proxy}`)
}

const { version } = (await Bun.file(path.join(repoRoot, 'package.json')).json()) as {
  version: string
}
const tag = `v${version}`

// Refuse to publish from a dirty tree — the tag should point at a known commit.
if ((await $`git status --porcelain`.text()).trim() !== '') {
  console.error('Error: working directory is not clean. Commit or stash changes first.')
  process.exit(1)
}

// Refuse to overwrite an existing tag. Bumping requires a package.json change.
if ((await $`git rev-parse ${tag}`.quiet().nothrow()).exitCode === 0) {
  console.error(`Error: tag ${tag} already exists. Bump version in package.json first.`)
  process.exit(1)
}

console.log(`Building ${tag} ...`)
await $`bun scripts/build.ts`

const glob = new Bun.Glob(`release/mac*/${APP_NAME}.app`)
const [distApp] = await Array.fromAsync(glob.scan({ cwd: repoRoot, onlyFiles: false }))
if (!distApp) {
  console.error(`Error: ${APP_NAME}.app not found under release/.`)
  process.exit(1)
}
const distAppAbs = path.join(repoRoot, distApp)

const archive = `release/${APP_NAME}.tar.gz`
await $`tar -czf ${archive} -C ${path.dirname(distAppAbs)} ${APP_NAME}.app`

await $`git tag -a ${tag} -m ${`Release ${tag}`}`
await $`git push origin ${tag}`

console.log(`Creating GitHub release ${tag} ...`)
try {
  await $`gh release create ${tag} ${archive} --title ${tag} --notes ${`Release ${tag}`}`
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
