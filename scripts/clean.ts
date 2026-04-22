#!/usr/bin/env bun
// Remove build artifacts (dist/ and release/).
import { rmSync } from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..')

for (const target of ['dist', 'release']) {
  rmSync(path.join(repoRoot, target), { recursive: true, force: true })
  console.log(`removed ${target}/`)
}
