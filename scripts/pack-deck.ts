#!/usr/bin/env bun
// Pack a Deck Source into a Deck Pack (.deck) file.
//
// Usage: ./scripts/pack-deck.ts <name>
//   Reads examples/<name>/ and writes examples/<name>.deck
import { existsSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import AdmZip from 'adm-zip'

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
if (!existsSync(path.join(srcDir, 'deck.json'))) {
  console.error(`missing deck.json in ${path.relative(repoRoot, srcDir)}`)
  process.exit(1)
}
if (!existsSync(path.join(srcDir, 'index.html'))) {
  console.error(`missing index.html in ${path.relative(repoRoot, srcDir)}`)
  process.exit(1)
}

// Overwrite any previous pack.
rmSync(outFile, { force: true })

// Skip dotfiles (.DS_Store, .fonts-source.json, etc.) so the pack stays
// minimal and doesn't leak local metadata. adm-zip's addLocalFolder filter
// receives forward-slash relative paths on every platform.
const zip = new AdmZip()
zip.addLocalFolder(srcDir, '', (entry) => !entry.split('/').some((seg) => seg.startsWith('.')))
zip.writeZip(outFile)

console.log(`packed → ${path.relative(repoRoot, outFile)}`)
