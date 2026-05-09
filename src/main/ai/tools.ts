import {
  createEditTool,
  createFindTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  withFileMutationQueue,
  type EditOperations,
  type FindOperations,
  type LsOperations,
  type ReadOperations,
  type WriteOperations,
} from '@earendil-works/pi-coding-agent'
import { type AgentTool } from '@earendil-works/pi-agent-core'
import { type Static, Type } from '@earendil-works/pi-ai'
import { existsSync, statSync } from 'node:fs'
import { access, mkdir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { net } from 'electron'
import {
  compileGlob,
  createDeckGrepTool,
  IGNORED_DIRS,
  walkFiles,
  type GrepOps,
} from '#/main/ai/grep-tool.ts'
import { editorSkillRoots } from '#/main/skills.ts'

/**
 * Tool surface for the Edit sub-view's Agent.
 *
 * We use pi-coding-agent's tool factories (read / write / edit / ls /
 * grep / find) rather than hand-rolling them — they're the same tools
 * the `pi` CLI ships, so the prompt behavior and tool-calling ergonomics
 * are well-exercised. Every factory takes an `operations` object; we
 * plug in a *sandboxed* implementation that rejects any path outside the
 * Deck Source (plus a read-only allowlist for Editor-appropriate skills,
 * so the model can read listed SKILL.md files by their absolute paths).
 *
 * One Deck-specific tool: `add_asset`. pi has no base64 binary inject
 * tool, and we need one because renderer attachment chips arrive over
 * IPC as bytes. Writing via `write_file` would require the model to
 * base64-round-trip through its own transcript — wasteful.
 *
 * grep / find: pi's defaults shell out to `rg` / `fd` and will silently
 * download those binaries from GitHub on first use. We override that
 * by providing custom `operations` — find runs through a Node glob
 * implementation, grep runs a Node-native scanner. No external binaries,
 * no surprise network I/O.
 *
 * Notably absent:
 *   - `bash` — letting an LLM run arbitrary shell commands is an
 *     unbounded capability; the read/write/edit/ls/grep/find surface
 *     covers everything Deck authoring actually needs. Removed in
 *     favor of fine-grained tools (see git history for the prior
 *     sandbox-exec wrapper).
 *   - `list_skills` / `read_skill` — pi's convention is that the system
 *     prompt lists skills with absolute paths, and the model reads them
 *     with the standard `read` tool. We allowlist only Editor-visible
 *     skill roots below.
 */

export interface DeckToolsContext {
  /** Absolute path to the Deck Source root. All tool ops are confined here. */
  rootDir: string
  /**
   * Optional notifier invoked after a tool mutates the Deck Source
   * (write / edit / add_asset / delete_file / move_file / fetch_url).
   * Used by the Edit sub-view to auto-reload the preview once the agent
   * has finished editing. Path is relative to rootDir, POSIX-style.
   * `move_file` fires it twice — once for the source, once for the
   * destination — so a watcher / preview reload picks up both sides.
   */
  onFileChange?: (relPath: string) => void
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

/**
 * String-only containment check. Used as a fast pre-filter and as the
 * ground truth for paths that don't yet exist on disk (writes to new
 * files). Symlink resolution lives in `realpathSafe` below.
 */
function isInsideString(abs: string, root: string): boolean {
  const a = path.resolve(abs)
  const r = path.resolve(root)
  return a === r || a.startsWith(r + path.sep)
}

/**
 * Resolve symlinks for sandbox checks. If the path itself doesn't exist
 * (a fresh write), walk up to the nearest existing ancestor, realpath
 * that, and rejoin the missing tail. This way a write to
 * `<root>/new/file` resolves through `<root>` (whose realpath we trust)
 * rather than failing the resolve and silently allowing a symlinked
 * `<root>` to escape.
 *
 * The escape vector this closes: a Deck Source containing a symlink
 * `escape -> /` would otherwise let `read_file('<root>/escape/etc/passwd')`
 * pass `isInsideString` (it's a string-prefix match) and then traverse
 * through the link in the underlying `readFile`.
 */
async function realpathSafe(p: string): Promise<string> {
  let current = path.resolve(p)
  const tail: string[] = []
  // Bound by the path depth — `path.dirname('/')` returns '/' so this
  // can't infinite-loop on POSIX. On Windows `path.dirname('C:\\')`
  // returns `'C:\\'` similarly.
  // Guarded with a hard ceiling regardless.
  for (let i = 0; i < 64; i++) {
    try {
      const real = await realpath(current)
      return tail.length === 0 ? real : path.join(real, ...tail)
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return path.join(current, ...tail)
      tail.unshift(path.basename(current))
      current = parent
    }
  }
  return path.resolve(p)
}

/**
 * Reject any path that escapes the writable sandbox. `writable` controls
 * whether the Editor-visible skill allowlist applies — it does for
 * read-only ops (read / ls) but NOT for mutating ops (write / edit)
 * because skills are shipped content, not user-authorable.
 *
 * We resolve `abs` AND each allowed root through `realpath` so symlinks
 * within the Deck Source can't be used to escape.
 */
async function ensureInSandbox(abs: string, rootDir: string, writable: boolean): Promise<void> {
  const allowedReadRoots = writable ? [] : editorSkillRoots()
  // Cheap string prefix first — catches `..` traversal before any I/O.
  if (!isInsideString(abs, rootDir) && !allowedReadRoots.some((root) => isInsideString(abs, root))) {
    throw new Error(`Path escapes the Deck sandbox: ${abs}`)
  }
  const real = await realpathSafe(abs)
  const realRoot = await realpathSafe(rootDir)
  if (isInsideString(real, realRoot)) return
  if (!writable) {
    for (const root of allowedReadRoots) {
      const realAllowedRoot = await realpathSafe(root)
      if (isInsideString(real, realAllowedRoot)) return
    }
  }
  throw new Error(`Path escapes the Deck sandbox: ${abs}`)
}

function toRelInsideRoot(abs: string, rootDir: string): string | null {
  const a = path.resolve(abs)
  const r = path.resolve(rootDir)
  if (a === r) return ''
  if (a.startsWith(r + path.sep)) return path.relative(r, a)
  return null
}

// ---------------------------------------------------------------------------
// Operations factories — wrap pi's defaults with sandbox checks
// ---------------------------------------------------------------------------

function readOps(rootDir: string): ReadOperations {
  return {
    readFile: async (abs) => {
      await ensureInSandbox(abs, rootDir, /* writable */ false)
      return readFile(abs)
    },
    access: async (abs) => {
      await ensureInSandbox(abs, rootDir, /* writable */ false)
      await access(abs)
    },
    // pi's default detectImageMimeType opens the file with `fs.open` — it
    // happens to be called after `access` today, so our sandbox gate in
    // `access` catches escapes before it runs. Override here anyway so
    // the sandbox doesn't depend on pi's call order.
    detectImageMimeType: async (abs) => {
      await ensureInSandbox(abs, rootDir, /* writable */ false)
      // Minimal magic-byte probe mirroring pi's behavior: read the head,
      // match against the image types pi accepts inline.
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
    },
  }
}

function writeOps(ctx: DeckToolsContext): WriteOperations {
  return {
    // pi's write tool wraps the entire mkdir+writeFile call in
    // withFileMutationQueue already — we do NOT re-lock here or we'd
    // deadlock (the mutex is not reentrant).
    writeFile: async (abs, content) => {
      await ensureInSandbox(abs, ctx.rootDir, /* writable */ true)
      await writeFile(abs, content, 'utf-8')
      const rel = toRelPosix(abs, ctx.rootDir)
      if (rel !== null) ctx.onFileChange?.(rel)
    },
    mkdir: async (dir) => {
      await ensureInSandbox(dir, ctx.rootDir, /* writable */ true)
      await mkdir(dir, { recursive: true })
    },
  }
}

function editOps(ctx: DeckToolsContext): EditOperations {
  return {
    // Same as writeOps: pi's edit tool holds the per-file mutex for
    // access+readFile+writeFile. Re-locking here would deadlock.
    readFile: async (abs) => {
      await ensureInSandbox(abs, ctx.rootDir, /* writable */ true)
      return readFile(abs)
    },
    writeFile: async (abs, content) => {
      await ensureInSandbox(abs, ctx.rootDir, /* writable */ true)
      await writeFile(abs, content, 'utf-8')
      const rel = toRelPosix(abs, ctx.rootDir)
      if (rel !== null) ctx.onFileChange?.(rel)
    },
    access: async (abs) => {
      await ensureInSandbox(abs, ctx.rootDir, /* writable */ true)
      await access(abs)
    },
  }
}

function lsOps(rootDir: string): LsOperations {
  return {
    exists: async (abs) => {
      await ensureInSandbox(abs, rootDir, /* writable */ false)
      return existsSync(abs)
    },
    stat: async (abs) => {
      await ensureInSandbox(abs, rootDir, /* writable */ false)
      return statSync(abs)
    },
    readdir: async (abs) => {
      await ensureInSandbox(abs, rootDir, /* writable */ false)
      return readdir(abs)
    },
  }
}

function grepOps(rootDir: string): GrepOps {
  return {
    isDirectory: async (abs) => {
      await ensureInSandbox(abs, rootDir, /* writable */ false)
      return (await stat(abs)).isDirectory()
    },
    readFile: async (abs) => {
      await ensureInSandbox(abs, rootDir, /* writable */ false)
      return readFile(abs, 'utf-8')
    },
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
function findOps(rootDir: string): FindOperations {
  return {
    exists: async (abs) => {
      await ensureInSandbox(abs, rootDir, /* writable */ false)
      return existsSync(abs)
    },
    glob: async (pattern, cwd, options) => {
      await ensureInSandbox(cwd, rootDir, /* writable */ false)

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
          `find expects a directory, got a file: ${cwd}. ` +
            `Use the read tool to inspect a single file's contents.`,
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

// ---------------------------------------------------------------------------
// Reserved-path policy
// ---------------------------------------------------------------------------

/**
 * Files the agent must reach via `write` / `edit`, not via the
 * convenience tools (`add_asset` for binaries, `delete_file` /
 * `move_file` for structural changes). Clobbering or losing these by
 * accident breaks the deck — the load path expects them at fixed names.
 *
 * Kept module-level so every tool that mutates the tree applies the
 * same list. Compared as POSIX paths relative to rootDir.
 */
const RESERVED_DECK_FILES: ReadonlySet<string> = new Set(['deck.json', 'index.html'])

function toRelPosix(abs: string, rootDir: string): string | null {
  const rel = toRelInsideRoot(abs, rootDir)
  if (rel === null) return null
  return rel.split(path.sep).join('/')
}

// ---------------------------------------------------------------------------
// add_asset — binary-injection tool
// ---------------------------------------------------------------------------

const addAssetSchema = Type.Object(
  {
    path: Type.String({
      description:
        'Relative path from the Deck Source root. If it contains no "/" ' +
        'the asset lands under "assets/". The filename must have an extension.',
    }),
    base64: Type.String({ description: 'File bytes, base64-encoded.' }),
  },
  { additionalProperties: false },
)
type AddAssetParams = Static<typeof addAssetSchema>

function addAssetTool(ctx: DeckToolsContext): AgentTool<typeof addAssetSchema> {
  return {
    name: 'add_asset',
    label: 'Add asset',
    description:
      'Write a binary asset (image / font / audio / video) into the Deck Source. ' +
      'Provide the file bytes as base64. Default location is assets/<name>; ' +
      'pass a full relative path to override. Existing files are overwritten.',
    parameters: addAssetSchema,
    execute: async (_id, params: AddAssetParams) => {
      // Reject absolute paths and any segment that climbs out — `..` would
      // pass the sandbox if the segments cancel out (`a/../deck.json`),
      // landing inside root but on a non-asset file. The tool is named
      // `add_asset`; clobbering deck.json / index.html via this path is a
      // contract violation regardless of being technically inside root.
      if (path.isAbsolute(params.path) || params.path.split(/[/\\]/).some((seg) => seg === '..')) {
        throw new Error(`add_asset path must be relative and within the Deck (no "..").`)
      }
      const hasDir = params.path.includes('/')
      const rel = hasDir ? params.path : path.posix.join('assets', params.path)
      if (!path.extname(rel)) {
        throw new Error(`Asset filename needs an extension: ${params.path}`)
      }
      // Reserved authoring files — agent uses `write` / `edit` for those.
      const relPosix = rel.split(path.sep).join('/')
      if (RESERVED_DECK_FILES.has(relPosix)) {
        throw new Error(`Refusing to overwrite ${relPosix} via add_asset; use write/edit instead.`)
      }
      const abs = path.resolve(ctx.rootDir, rel)
      await ensureInSandbox(abs, ctx.rootDir, /* writable */ true)
      await mkdir(path.dirname(abs), { recursive: true })
      const buf = Buffer.from(params.base64, 'base64')
      await withFileMutationQueue(abs, async () => {
        await writeFile(abs, buf)
      })
      ctx.onFileChange?.(rel)
      return {
        content: [{ type: 'text', text: `Added ${rel} (${buf.length} bytes)` }],
        details: { path: rel, bytes: buf.length },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// delete_file — remove a single file from the Deck Source
// ---------------------------------------------------------------------------

const deleteFileSchema = Type.Object(
  {
    path: Type.String({
      description:
        'Path of the file to delete. Relative paths resolve against the Deck Source root. ' +
        'Directories are not supported — use repeated calls if needed.',
    }),
  },
  { additionalProperties: false },
)
type DeleteFileParams = Static<typeof deleteFileSchema>

function deleteFileTool(ctx: DeckToolsContext): AgentTool<typeof deleteFileSchema> {
  return {
    name: 'delete_file',
    label: 'Delete file',
    description:
      'Permanently delete a single file inside the Deck Source. Refuses directories ' +
      'and the reserved files (deck.json, index.html) — those are edited, not deleted. ' +
      'Use this rather than emulating delete via write_file with empty content.',
    parameters: deleteFileSchema,
    execute: async (_id, params: DeleteFileParams) => {
      const abs = path.resolve(ctx.rootDir, params.path)
      await ensureInSandbox(abs, ctx.rootDir, /* writable */ true)
      const relPosix = toRelPosix(abs, ctx.rootDir)
      if (relPosix === null) {
        // ensureInSandbox should already have thrown, but defense in depth.
        throw new Error(`Path escapes the Deck sandbox: ${params.path}`)
      }
      if (relPosix === '') {
        throw new Error('Refusing to delete the Deck Source root.')
      }
      if (RESERVED_DECK_FILES.has(relPosix)) {
        throw new Error(`Refusing to delete ${relPosix}; use write/edit to modify it instead.`)
      }
      let st: import('node:fs').Stats
      try {
        st = await stat(abs)
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code === 'ENOENT') throw new Error(`File not found: ${relPosix}`)
        throw e
      }
      if (st.isDirectory()) {
        throw new Error(
          `delete_file targets a directory: ${relPosix}. Directory removal is not supported.`,
        )
      }
      await withFileMutationQueue(abs, async () => {
        await unlink(abs)
      })
      ctx.onFileChange?.(relPosix)
      return {
        content: [{ type: 'text', text: `Deleted ${relPosix}` }],
        details: { path: relPosix },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// move_file — rename / move a file within the Deck Source
// ---------------------------------------------------------------------------

const moveFileSchema = Type.Object(
  {
    from: Type.String({ description: 'Existing path, relative to the Deck Source root.' }),
    to: Type.String({
      description:
        'Destination path, relative to the Deck Source root. Parent directories are ' +
        'created as needed. Overwriting an existing file is refused unless overwrite=true.',
    }),
    overwrite: Type.Optional(
      Type.Boolean({
        description: 'Allow replacing an existing file at the destination (default: false).',
      }),
    ),
  },
  { additionalProperties: false },
)
type MoveFileParams = Static<typeof moveFileSchema>

function moveFileTool(ctx: DeckToolsContext): AgentTool<typeof moveFileSchema> {
  return {
    name: 'move_file',
    label: 'Move file',
    description:
      'Rename or move a single file inside the Deck Source. Both endpoints must stay ' +
      'within the Deck Source. Refuses to clobber or relocate the reserved files ' +
      '(deck.json, index.html). Cross-device renames fall back to copy+delete.',
    parameters: moveFileSchema,
    execute: async (_id, params: MoveFileParams) => {
      const fromAbs = path.resolve(ctx.rootDir, params.from)
      const toAbs = path.resolve(ctx.rootDir, params.to)
      await ensureInSandbox(fromAbs, ctx.rootDir, /* writable */ true)
      await ensureInSandbox(toAbs, ctx.rootDir, /* writable */ true)
      const fromRel = toRelPosix(fromAbs, ctx.rootDir)
      const toRel = toRelPosix(toAbs, ctx.rootDir)
      if (fromRel === null || toRel === null) {
        throw new Error('Both `from` and `to` must be inside the Deck Source.')
      }
      if (fromRel === '' || toRel === '') {
        throw new Error('Refusing to move the Deck Source root.')
      }
      if (fromRel === toRel) {
        // No-op rename — return early so we don't churn the file watcher.
        return {
          content: [{ type: 'text', text: `move_file no-op: ${fromRel} == ${toRel}` }],
          details: { from: fromRel, to: toRel, noop: true },
        }
      }
      if (RESERVED_DECK_FILES.has(fromRel)) {
        throw new Error(`Refusing to move reserved file ${fromRel}; edit it in place.`)
      }
      if (RESERVED_DECK_FILES.has(toRel)) {
        throw new Error(
          `Refusing to overwrite reserved file ${toRel} via move_file; use write/edit instead.`,
        )
      }

      let fromStat: import('node:fs').Stats
      try {
        fromStat = await stat(fromAbs)
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code === 'ENOENT') throw new Error(`Source not found: ${fromRel}`)
        throw e
      }
      if (fromStat.isDirectory()) {
        throw new Error(
          `move_file targets a directory: ${fromRel}. Directory moves are not supported.`,
        )
      }

      if (existsSync(toAbs)) {
        const toStat = statSync(toAbs)
        if (toStat.isDirectory()) {
          throw new Error(`Destination is a directory: ${toRel}. Pass a file path.`)
        }
        if (!params.overwrite) {
          throw new Error(`Destination already exists: ${toRel}. Pass overwrite=true to replace.`)
        }
      }

      await mkdir(path.dirname(toAbs), { recursive: true })
      // Two file paths share one move — lock both (alphabetically) so a
      // concurrent edit on either side serializes against us.
      const [a, b] = fromAbs < toAbs ? [fromAbs, toAbs] : [toAbs, fromAbs]
      await withFileMutationQueue(a, async () => {
        await withFileMutationQueue(b, async () => {
          try {
            await rename(fromAbs, toAbs)
          } catch (e) {
            // EXDEV: source/dest live on different filesystems (rare but
            // possible if rootDir is a bind-mount or a tmpdir on another
            // device). Fall back to copy + unlink so move_file works
            // anywhere. Anything else is a real error.
            const code = (e as NodeJS.ErrnoException).code
            if (code !== 'EXDEV') throw e
            const buf = await readFile(fromAbs)
            await writeFile(toAbs, buf)
            await unlink(fromAbs)
          }
        })
      })
      // Notify both sides so the watcher / preview reload picks up
      // disappearance and appearance.
      ctx.onFileChange?.(fromRel)
      ctx.onFileChange?.(toRel)
      return {
        content: [{ type: 'text', text: `Moved ${fromRel} → ${toRel}` }],
        details: { from: fromRel, to: toRel },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// validate_deck — sanity-check deck.json + index.html references
// ---------------------------------------------------------------------------

/**
 * Pull all `src` / `href` values out of an HTML string. Intentionally
 * regex-based (not a full HTML parser): the rendered page itself is
 * what runs in production, and we just want a low-cost "did the model
 * reference a path that doesn't exist". Misses fancy cases (CSS
 * `url(...)`, dynamic `import()`, `<source srcset>`); good enough as a
 * smoke test, and the model can still ask `read` for a deeper look.
 *
 * HTML comments are stripped before scanning so a commented-out
 * `<img src="old.png">` doesn't produce a false-positive "missing
 * referenced file" — the browser ignores those, and so should we.
 */
function extractHtmlRefs(html: string): string[] {
  const stripped = html.replace(/<!--[\s\S]*?-->/g, '')
  const out: string[] = []
  const re = /\b(?:src|href)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi
  for (const m of stripped.matchAll(re)) {
    const v = m[2] ?? m[3] ?? m[4]
    if (v) out.push(v)
  }
  return out
}

function isExternalOrInline(ref: string): boolean {
  // External or non-file refs we don't try to validate.
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return true // http:, https:, data:, mailto:, etc.
  if (ref.startsWith('//')) return true // protocol-relative
  if (ref.startsWith('#')) return true // fragment
  return false
}

const validateDeckSchema = Type.Object({}, { additionalProperties: false })
type ValidateDeckParams = Static<typeof validateDeckSchema>

function validateDeckTool(ctx: DeckToolsContext): AgentTool<typeof validateDeckSchema> {
  return {
    name: 'validate_deck',
    label: 'Validate deck',
    description:
      'Sanity-check the Deck Source: parses deck.json and scans index.html for ' +
      'src/href references that point to missing files. Read-only — does not modify ' +
      'anything. Use after structural changes to confirm the deck is still loadable.',
    parameters: validateDeckSchema,
    execute: async (_id, _params: ValidateDeckParams) => {
      const issues: string[] = []
      const ok: string[] = []

      // deck.json
      const manifestAbs = path.join(ctx.rootDir, 'deck.json')
      let manifest: { name?: unknown } | null = null
      if (!existsSync(manifestAbs)) {
        issues.push('deck.json: missing at the Deck Source root')
      } else {
        try {
          const raw = await readFile(manifestAbs, 'utf-8')
          const parsed = JSON.parse(raw) as { name?: unknown }
          manifest = parsed
          if (typeof parsed.name !== 'string' || parsed.name.trim() === '') {
            issues.push('deck.json: `name` must be a non-empty string')
          } else {
            ok.push(`deck.json: name = ${parsed.name}`)
          }
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e)
          issues.push(`deck.json: invalid JSON (${reason})`)
        }
      }

      // index.html
      const indexAbs = path.join(ctx.rootDir, 'index.html')
      if (!existsSync(indexAbs)) {
        issues.push('index.html: missing at the Deck Source root')
      } else {
        let html: string
        try {
          html = await readFile(indexAbs, 'utf-8')
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e)
          issues.push(`index.html: unreadable (${reason})`)
          html = ''
        }
        const refs = extractHtmlRefs(html)
        const checked = new Set<string>()
        let missingCount = 0
        for (const ref of refs) {
          if (isExternalOrInline(ref)) continue
          // Strip query / fragment — they're not part of the file path.
          const cleaned = ref.replace(/[?#].*$/, '')
          if (!cleaned) continue
          if (checked.has(cleaned)) continue
          checked.add(cleaned)
          // Anchor refs at the Deck Source root (this is what the local
          // server does — the deck is served with rootDir as the doc root).
          const refAbs = path.resolve(ctx.rootDir, cleaned.replace(/^\/+/, ''))
          // Even though refs are author-controlled, run the sandbox
          // check so a stray `../foo` isn't reported as a Deck file.
          try {
            await ensureInSandbox(refAbs, ctx.rootDir, /* writable */ false)
          } catch {
            issues.push(`index.html: reference escapes the Deck Source: ${ref}`)
            missingCount++
            continue
          }
          if (!existsSync(refAbs)) {
            issues.push(`index.html: missing referenced file: ${cleaned}`)
            missingCount++
          }
        }
        ok.push(`index.html: scanned ${checked.size} local refs, ${missingCount} missing`)
      }

      const summary = issues.length === 0 ? 'OK' : `${issues.length} issue(s)`
      const lines = [`Deck validation: ${summary}`, ...issues.map((s) => `  ✗ ${s}`), '', 'Checks:', ...ok.map((s) => `  • ${s}`)]
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        details: { issues, ok, manifest },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// fetch_url — download a remote file into the Deck Source
// ---------------------------------------------------------------------------

const FETCH_URL_MAX_BYTES = 25 * 1024 * 1024 // 25 MB — enough for most images / fonts / short videos

const fetchUrlSchema = Type.Object(
  {
    url: Type.String({ description: 'http(s) URL to download.' }),
    path: Type.String({
      description:
        'Destination relative path inside the Deck Source. If it contains no "/" the ' +
        'file lands under "assets/". The filename must have an extension.',
    }),
    overwrite: Type.Optional(
      Type.Boolean({ description: 'Allow replacing an existing file (default: false).' }),
    ),
  },
  { additionalProperties: false },
)
type FetchUrlParams = Static<typeof fetchUrlSchema>

function fetchUrlTool(ctx: DeckToolsContext): AgentTool<typeof fetchUrlSchema> {
  return {
    name: 'fetch_url',
    label: 'Fetch URL',
    description:
      `Download a remote file (http/https only) into the Deck Source. Default ` +
      `location is assets/<name>; pass a full relative path to override. Caps at ` +
      `${FETCH_URL_MAX_BYTES / (1024 * 1024)} MB. Refuses non-http(s) schemes and the ` +
      `reserved files (deck.json, index.html).`,
    parameters: fetchUrlSchema,
    execute: async (_id, params: FetchUrlParams, signal) => {
      // Scheme + host gate. We use Electron's `net.fetch` rather than
      // global fetch because it routes through Electron's session
      // (proxy / cookies the user expects), and it's the documented main
      // -process HTTP client.
      let parsed: URL
      try {
        parsed = new URL(params.url)
      } catch {
        throw new Error(`Invalid URL: ${params.url}`)
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`fetch_url only supports http(s); got ${parsed.protocol}`)
      }

      // Path policy mirrors add_asset.
      if (path.isAbsolute(params.path) || params.path.split(/[/\\]/).some((seg) => seg === '..')) {
        throw new Error(`fetch_url path must be relative and within the Deck (no "..").`)
      }
      const hasDir = params.path.includes('/')
      const rel = hasDir ? params.path : path.posix.join('assets', params.path)
      if (!path.extname(rel)) {
        throw new Error(`Destination filename needs an extension: ${params.path}`)
      }
      const relPosix = rel.split(path.sep).join('/')
      if (RESERVED_DECK_FILES.has(relPosix)) {
        throw new Error(`Refusing to overwrite ${relPosix} via fetch_url; use write/edit instead.`)
      }
      const abs = path.resolve(ctx.rootDir, rel)
      await ensureInSandbox(abs, ctx.rootDir, /* writable */ true)
      if (existsSync(abs) && !params.overwrite) {
        throw new Error(
          `Destination already exists: ${relPosix}. Pass overwrite=true to replace.`,
        )
      }

      const res = await net.fetch(parsed.toString(), { redirect: 'follow', signal })
      if (!res.ok) {
        throw new Error(`fetch_url ${parsed.toString()} -> HTTP ${res.status} ${res.statusText}`)
      }

      // Cheap pre-check via Content-Length, then a hard cap during read
      // (since servers can lie or omit the header).
      const lenHeader = res.headers.get('content-length')
      if (lenHeader && Number(lenHeader) > FETCH_URL_MAX_BYTES) {
        throw new Error(
          `Remote file ${lenHeader} bytes exceeds ${FETCH_URL_MAX_BYTES} byte cap.`,
        )
      }
      const body = res.body
      if (!body) {
        throw new Error('fetch_url got an empty response body.')
      }
      const chunks: Uint8Array[] = []
      let total = 0
      const reader = body.getReader()
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (!value) continue
        total += value.byteLength
        if (total > FETCH_URL_MAX_BYTES) {
          // Best-effort cancel so the connection doesn't keep streaming.
          try {
            await reader.cancel()
          } catch {
            // already closed
          }
          throw new Error(
            `Remote file exceeds ${FETCH_URL_MAX_BYTES} byte cap (read ${total} bytes).`,
          )
        }
        chunks.push(value)
      }
      const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)))

      await mkdir(path.dirname(abs), { recursive: true })
      await withFileMutationQueue(abs, async () => {
        await writeFile(abs, buf)
      })
      ctx.onFileChange?.(relPosix)
      return {
        content: [
          {
            type: 'text',
            text: `Fetched ${parsed.toString()} -> ${relPosix} (${buf.length} bytes)`,
          },
        ],
        details: { url: parsed.toString(), path: relPosix, bytes: buf.length },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Public: tool set for a Deck editor session
// ---------------------------------------------------------------------------

export function createDeckTools(ctx: DeckToolsContext): AgentTool<any>[] {
  const { rootDir } = ctx
  // pi's factories accept relative paths from the model and resolve them
  // against `cwd`. rootDir is an absolute path (see deck-loader.ts), so
  // passing it directly works.
  return [
    createReadTool(rootDir, { operations: readOps(rootDir) }),
    createWriteTool(rootDir, { operations: writeOps(ctx) }),
    createEditTool(rootDir, { operations: editOps(ctx) }),
    createLsTool(rootDir, { operations: lsOps(rootDir) }),
    createDeckGrepTool({ cwd: rootDir, operations: grepOps(rootDir) }),
    createFindTool(rootDir, { operations: findOps(rootDir) }),
    addAssetTool(ctx),
    deleteFileTool(ctx),
    moveFileTool(ctx),
    validateDeckTool(ctx),
    fetchUrlTool(ctx),
  ]
}

// ---------------------------------------------------------------------------
// Deck Source summary for the system prompt
// ---------------------------------------------------------------------------

/**
 * Describe the Deck Source (two levels deep + a line from deck.json) so
 * the system prompt can orient the model without a preliminary `ls` call.
 *
 * Two levels matches the realistic Deck shape: root holds index.html /
 * deck.json / styles.css, and typically one of `assets/` / `slides/` /
 * `scripts/` below. Going deeper risks dumping a bulky `assets/` listing
 * into every system prompt.
 */
export async function describeDeckSource(rootDir: string): Promise<string> {
  const MAX_CHILDREN_PER_DIR = 40
  const lines: string[] = []
  try {
    const topEntries = await readdir(rootDir, { withFileTypes: true })
    const topVisible = topEntries.filter((e) => !e.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name))
    lines.push('Entries (two levels deep):')
    for (const entry of topVisible) {
      if (!entry.isDirectory()) {
        lines.push(`  - ${entry.name}`)
        continue
      }
      lines.push(`  - ${entry.name}/`)
      try {
        const childEntries = await readdir(path.join(rootDir, entry.name), { withFileTypes: true })
        const childVisible = childEntries
          .filter((e) => !e.name.startsWith('.'))
          .sort((a, b) => a.name.localeCompare(b.name))
        const shown = childVisible.slice(0, MAX_CHILDREN_PER_DIR)
        for (const child of shown) {
          lines.push(`      - ${child.name}${child.isDirectory() ? '/' : ''}`)
        }
        if (childVisible.length > shown.length) {
          lines.push(`      … ${childVisible.length - shown.length} more`)
        }
      } catch {
        lines.push(`      (could not list)`)
      }
    }
  } catch {
    lines.push('(could not list Deck Source root)')
  }
  const manifestPath = path.join(rootDir, 'deck.json')
  if (existsSync(manifestPath)) {
    try {
      const raw = await readFile(manifestPath, 'utf8')
      const parsed = JSON.parse(raw) as { name?: string; author?: string; description?: string }
      lines.push('', 'deck.json:')
      if (parsed.name) lines.push(`  name: ${parsed.name}`)
      if (parsed.author) lines.push(`  author: ${parsed.author}`)
      if (parsed.description) lines.push(`  description: ${parsed.description}`)
    } catch {
      // malformed deck.json — the author will hit validation errors elsewhere
    }
  }
  return lines.join('\n')
}
