#!/usr/bin/env bun
// Pack a Deck Source into a Deck Pack (.deck) file.
//
// Usage: ./scripts/pack-deck.ts <name>
//   Reads examples/<name>/ and writes examples/<name>.deck
//
// Delegates to the same packer the in-app Save uses (src/main/deck-packer.ts)
// so the dev script and the user-visible Save apply identical skip rules.
import { existsSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { packDeck } from '#/main/deck-packer.ts'

const repoRoot = path.resolve(import.meta.dirname, '..')

const name = process.argv[2]
if (!name) {
  console.error('usage: scripts/pack-deck.ts <deck-name>')
  process.exit(1)
}

const srcDir = path.join(repoRoot, 'examples', name)
const outFile = path.join(repoRoot, 'examples', `${name}.deck`)

if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
  console.error(`source dir not found: ${path.relative(repoRoot, srcDir)}`)
  process.exit(1)
}

// Overwrite any previous pack.
rmSync(outFile, { force: true })

try {
  const result = await packDeck(srcDir, outFile)
  console.log(`packed → ${path.relative(repoRoot, outFile)} (${result.fileCount} files, ${result.bytes} bytes)`)
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
