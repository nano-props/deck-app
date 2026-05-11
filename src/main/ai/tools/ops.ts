/**
 * Ops layer — sandboxed I/O primitives plugged into pi-coding-agent's
 * tool factories.
 *
 * Each `*Ops()` function returns the `Operations` shape pi expects
 * (`ReadOperations`, `WriteOperations`, etc.) with every method wrapped
 * by `sandboxed` from sandbox.ts. The mutating factories (`writeOps`,
 * `editOps`) additionally call `validateReservedFileContent` so a
 * malformed deck.json is rejected before it lands on disk.
 *
 * `findOps` overrides pi's default fd-binary path with a Node-native
 * glob — see the function's own comment for why. `grepOps` similarly
 * pairs with `createDeckGrepTool` (in `ai/grep-tool.ts`) which avoids
 * pi's ripgrep binary download.
 *
 * The mutex contract for write/edit/queue ordering is owned by
 * pi-coding-agent's `withFileMutationQueue` (used in handlers, not
 * here): the per-file lock is held around access+readFile+writeFile,
 * so these factories deliberately do NOT re-lock — pi's lock is not
 * reentrant.
 */
import {
  type EditOperations,
  type FindOperations,
  type LsOperations,
  type ReadOperations,
  type WriteOperations,
} from '@earendil-works/pi-coding-agent'
import { existsSync, statSync } from 'node:fs'
import { access, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { compileGlob, IGNORED_DIRS, walkFiles, type GrepOps } from '#/main/ai/grep-tool.ts'
import { resolveSandboxPath, sandboxed } from './sandbox.ts'
import { validateReservedFileContent } from './reserved.ts'
import type { DeckToolsContext } from './context.ts'

// Minimal magic-byte probe mirroring pi's behavior: read the head,
// match against the image types pi accepts inline.
async function detectImageMimeType(abs: string): Promise<string | null> {
  const buf = await readFile(abs)
  if (buf.length < 4) return null
  const b = buf
  // JPEG FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  // PNG 89 50 4E 47
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  // GIF "GIF8"
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'
  // WebP: RIFF....WEBP
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) {
    return 'image/webp'
  }
  return null
}

export function readOps(rootDir: string): ReadOperations {
  return {
    readFile: sandboxed(rootDir, false, (abs) => readFile(abs)),
    access: sandboxed(rootDir, false, (abs) => access(abs)),
    // pi's default detectImageMimeType opens the file with `fs.open` — it
    // happens to be called after `access` today, so our sandbox gate in
    // `access` catches escapes before it runs. Override here anyway so
    // the sandbox doesn't depend on pi's call order.
    detectImageMimeType: sandboxed(rootDir, false, detectImageMimeType),
  }
}

export function writeOps(ctx: DeckToolsContext): WriteOperations {
  // pi's write tool wraps the entire mkdir+writeFile call in
  // withFileMutationQueue already — we do NOT re-lock here or we'd
  // deadlock (the mutex is not reentrant).
  return {
    writeFile: async (abs, content) => {
      const checked = await resolveSandboxPath(abs, ctx.rootDir, /* writable */ true)
      validateReservedFileContent(checked.relPath, content)
      await writeFile(abs, content, 'utf-8')
      if (checked.relPath !== null) ctx.onFileChange?.(checked.relPath)
    },
    mkdir: sandboxed(ctx.rootDir, true, async (dir) => {
      await mkdir(dir, { recursive: true })
    }),
  }
}

export function editOps(ctx: DeckToolsContext): EditOperations {
  // pi's edit tool holds the per-file mutex around access+readFile+
  // writeFile, so we don't re-lock — the mutex is not reentrant.
  // Edit is mutating, so the writable=true sandbox excludes the
  // read-only skill allowlist.
  return {
    readFile: sandboxed(ctx.rootDir, true, (abs) => readFile(abs)),
    writeFile: async (abs, content) => {
      const checked = await resolveSandboxPath(abs, ctx.rootDir, /* writable */ true)
      validateReservedFileContent(checked.relPath, content)
      await writeFile(abs, content, 'utf-8')
      if (checked.relPath !== null) ctx.onFileChange?.(checked.relPath)
    },
    access: sandboxed(ctx.rootDir, true, (abs) => access(abs)),
  }
}

export function lsOps(rootDir: string): LsOperations {
  return {
    exists: sandboxed(rootDir, false, (abs) => existsSync(abs)),
    stat: sandboxed(rootDir, false, (abs) => statSync(abs)),
    readdir: sandboxed(rootDir, false, (abs) => readdir(abs)),
  }
}

export function grepOps(rootDir: string): GrepOps {
  return {
    isDirectory: sandboxed(rootDir, false, async (abs) => (await stat(abs)).isDirectory()),
    readFile: sandboxed(rootDir, false, (abs) => readFile(abs, 'utf-8')),
  }
}

/**
 * Find ops with a Node-native glob impl. Providing a `glob` function
 * short-circuits pi's fd path entirely (see pi-coding-agent's find.ts:
 * `if (customOps?.glob) { ...; return; }` runs before `ensureTool('fd')`).
 *
 * Glob syntax + walk semantics are shared with grep via grep-tool.ts —
 * keeping both tools consistent on what counts as "skip this directory"
 * and what `**` means.
 *
 * Pi's loop only validates `exists()` upstream, so a model passing a
 * file path would otherwise hit `readdir`'s ENOTDIR and get a confusing
 * "no files found" (or worse — pi relativizes `[cwd]` against itself
 * to a single empty-string line). We refuse that call up front.
 */
export function findOps(rootDir: string): FindOperations {
  return {
    exists: sandboxed(rootDir, false, (abs) => existsSync(abs)),
    glob: async (pattern, cwd, options) => {
      await resolveSandboxPath(cwd, rootDir, /* writable */ false)

      // stat throws on broken symlinks / permission denials; treat that
      // as "not provably a file" and let the walk produce an empty result.
      let cwdStats: import('node:fs').Stats | undefined
      try {
        cwdStats = await stat(cwd)
      } catch {
        // fall through
      }
      if (cwdStats?.isFile()) {
        throw new Error(
          `find expects a directory, got a file: ${cwd}. ` + `Use the read tool to inspect a single file's contents.`,
        )
      }

      const { re, anchored } = compileGlob(pattern)
      const results: string[] = []
      for await (const file of walkFiles(cwd, IGNORED_DIRS)) {
        if (results.length >= options.limit) break
        const rel = path.relative(cwd, file).replace(/\\/g, '/')
        const target = anchored ? rel : path.basename(rel)
        if (re.test(target)) results.push(file)
      }
      return results
    },
  }
}
