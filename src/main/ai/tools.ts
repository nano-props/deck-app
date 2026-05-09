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
import { net, nativeImage } from 'electron'
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
  /**
   * Optional preview-snapshot capture, supplied by the session layer.
   * When present, `screenshot_preview` is exposed to the agent so it
   * can see the rendered deck. Absent in tests / unit-construction
   * paths that don't own a live deckView — the tool is omitted in that
   * case, so the model never sees a tool that would always fail.
   */
  capturePreview?: () => Promise<{ dataUrl: string } | null>
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

// Cache realpath of trusted roots (deck rootDir + editor-visible skill
// dirs). These don't move during a session — re-walking the symlink
// chain on every tool call wastes I/O proportional to tool-call rate
// (read/grep/find can hit this hundreds of times per turn). Cache miss
// is rare (one entry per deck session + one per skill dir).
const realpathRootCache = new Map<string, Promise<string>>()
function realpathRootCached(p: string): Promise<string> {
  let cached = realpathRootCache.get(p)
  if (!cached) {
    cached = realpathSafe(p)
    realpathRootCache.set(p, cached)
  }
  return cached
}

/**
 * Reject any path that escapes the writable sandbox. `writable` controls
 * whether the Editor-visible skill allowlist applies — it does for
 * read-only ops (read / ls) but NOT for mutating ops (write / edit)
 * because skills are shipped content, not user-authorable.
 *
 * The candidate path goes through `realpath` fresh (it can be a brand-
 * new file the model is about to create); the trusted roots are cached
 * (see `realpathRootCached`).
 */
async function ensureInSandbox(abs: string, rootDir: string, writable: boolean): Promise<void> {
  const allowedReadRoots = writable ? [] : editorSkillRoots()
  // Cheap string prefix first — catches `..` traversal before any I/O.
  if (!isInsideString(abs, rootDir) && !allowedReadRoots.some((root) => isInsideString(abs, root))) {
    throw new Error(`Path escapes the Deck sandbox: ${abs}`)
  }
  const real = await realpathSafe(abs)
  const realRoot = await realpathRootCached(rootDir)
  if (isInsideString(real, realRoot)) return
  if (!writable) {
    for (const root of allowedReadRoots) {
      const realAllowedRoot = await realpathRootCached(root)
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

/**
 * Wrap an `(abs, ...) => R` function so it gates on `ensureInSandbox`
 * before delegating. Suitable for ops where the only side effect is the
 * one inside `fn` itself; ops that also need to fire `onFileChange` or
 * run extra validation (writeFile, edit's writeFile) keep an explicit
 * handler so the post-write step is visible at the call site.
 *
 * Call sites pass arrow lambdas (`(abs) => readFile(abs)`) rather than
 * raw function references because the fs/promises overloads return
 * `Buffer | string` depending on whether an `encoding` option is set,
 * and TypeScript can't narrow that through a generic wrapper. Calling
 * the function inside a lambda lets overload resolution pick the
 * concrete return type at the call site.
 */
function sandboxed<A extends unknown[], R>(
  rootDir: string,
  writable: boolean,
  fn: (abs: string, ...rest: A) => R | Promise<R>,
): (abs: string, ...rest: A) => Promise<R> {
  return async (abs, ...rest) => {
    await ensureInSandbox(abs, rootDir, writable)
    return fn(abs, ...rest)
  }
}

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

function readOps(rootDir: string): ReadOperations {
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

/**
 * Single source of truth for deck.json's expected shape. Returns a
 * (possibly empty) list of human-readable problems. Shared by the
 * write-time validator (which throws on any issue) and the
 * `validate_deck` read-time tool (which collects them into a report) —
 * extending the schema (e.g. requiring `version`) only needs one edit.
 */
function checkDeckJsonShape(parsed: unknown): string[] {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return ['must be a JSON object']
  }
  const issues: string[] = []
  const name = (parsed as { name?: unknown }).name
  if (typeof name !== 'string' || name.trim() === '') {
    issues.push('`name` must be a non-empty string')
  }
  return issues
}

/**
 * Hard-validate the contents the model is about to write to a reserved
 * deck-source file. Today only `deck.json` has machine-checkable
 * structure; we keep this file-by-file so it's obvious where to extend
 * (e.g. a future schema check on index.html).
 *
 * Throwing here surfaces as a tool error in the chat — pi serializes
 * the message and the model gets a chance to fix and retry. Without
 * this guard a malformed `deck.json` would land on disk and break the
 * next `loadDeck` call.
 */
function validateReservedFileContent(abs: string, rootDir: string, content: string): void {
  const rel = toRelPosix(abs, rootDir)
  if (rel !== 'deck.json') return
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    throw new Error(`Refusing to write deck.json: invalid JSON (${reason}).`)
  }
  const issues = checkDeckJsonShape(parsed)
  if (issues.length > 0) {
    throw new Error(`Refusing to write deck.json: ${issues.join('; ')}.`)
  }
}

function writeOps(ctx: DeckToolsContext): WriteOperations {
  // pi's write tool wraps the entire mkdir+writeFile call in
  // withFileMutationQueue already — we do NOT re-lock here or we'd
  // deadlock (the mutex is not reentrant).
  return {
    writeFile: async (abs, content) => {
      await ensureInSandbox(abs, ctx.rootDir, /* writable */ true)
      validateReservedFileContent(abs, ctx.rootDir, content)
      await writeFile(abs, content, 'utf-8')
      const rel = toRelPosix(abs, ctx.rootDir)
      if (rel !== null) ctx.onFileChange?.(rel)
    },
    mkdir: sandboxed(ctx.rootDir, true, async (dir) => {
      await mkdir(dir, { recursive: true })
    }),
  }
}

function editOps(ctx: DeckToolsContext): EditOperations {
  // pi's edit tool holds the per-file mutex around access+readFile+
  // writeFile, so we don't re-lock — the mutex is not reentrant.
  // Edit is mutating, so the writable=true sandbox excludes the
  // read-only skill allowlist.
  return {
    readFile: sandboxed(ctx.rootDir, true, (abs) => readFile(abs)),
    writeFile: async (abs, content) => {
      await ensureInSandbox(abs, ctx.rootDir, /* writable */ true)
      validateReservedFileContent(abs, ctx.rootDir, content)
      await writeFile(abs, content, 'utf-8')
      const rel = toRelPosix(abs, ctx.rootDir)
      if (rel !== null) ctx.onFileChange?.(rel)
    },
    access: sandboxed(ctx.rootDir, true, (abs) => access(abs)),
  }
}

function lsOps(rootDir: string): LsOperations {
  return {
    exists: sandboxed(rootDir, false, (abs) => existsSync(abs)),
    stat: sandboxed(rootDir, false, (abs) => statSync(abs)),
    readdir: sandboxed(rootDir, false, (abs) => readdir(abs)),
  }
}

function grepOps(rootDir: string): GrepOps {
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
function findOps(rootDir: string): FindOperations {
  return {
    exists: sandboxed(rootDir, false, (abs) => existsSync(abs)),
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
      // Tolerate a leading `data:<mime>;base64,` prefix — models
      // occasionally hand the full data URL straight from a clipboard.
      // Buffer.from silently strips invalid characters, so we also
      // require the result to be non-empty for a non-empty input.
      const stripped = params.base64.replace(/^data:[^;,]*;base64,/i, '').trim()
      if (!stripped) {
        throw new Error('add_asset: empty base64 payload.')
      }
      const buf = Buffer.from(stripped, 'base64')
      if (buf.length === 0) {
        throw new Error('add_asset: base64 decode produced 0 bytes — likely malformed input.')
      }
      await mkdir(path.dirname(abs), { recursive: true })
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

interface DeckCheckResult {
  issues: string[]
  ok: string[]
  manifest: { name?: unknown } | null
}

async function checkDeckJson(rootDir: string): Promise<DeckCheckResult> {
  const manifestAbs = path.join(rootDir, 'deck.json')
  if (!existsSync(manifestAbs)) {
    return { issues: ['deck.json: missing at the Deck Source root'], ok: [], manifest: null }
  }
  let raw: string
  try {
    raw = await readFile(manifestAbs, 'utf-8')
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    return { issues: [`deck.json: unreadable (${reason})`], ok: [], manifest: null }
  }
  let parsed: { name?: unknown }
  try {
    parsed = JSON.parse(raw) as { name?: unknown }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    return { issues: [`deck.json: invalid JSON (${reason})`], ok: [], manifest: null }
  }
  const shapeIssues = checkDeckJsonShape(parsed).map((s) => `deck.json: ${s}`)
  const ok =
    shapeIssues.length === 0 && typeof parsed.name === 'string'
      ? [`deck.json: name = ${parsed.name}`]
      : []
  return { issues: shapeIssues, ok, manifest: parsed }
}

async function checkIndexHtml(rootDir: string): Promise<Pick<DeckCheckResult, 'issues' | 'ok'>> {
  const indexAbs = path.join(rootDir, 'index.html')
  if (!existsSync(indexAbs)) {
    return { issues: ['index.html: missing at the Deck Source root'], ok: [] }
  }
  let html: string
  try {
    html = await readFile(indexAbs, 'utf-8')
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    return { issues: [`index.html: unreadable (${reason})`], ok: [] }
  }
  const issues: string[] = []
  const checked = new Set<string>()
  let missingCount = 0
  for (const ref of extractHtmlRefs(html)) {
    if (isExternalOrInline(ref)) continue
    // Strip query / fragment — they're not part of the file path.
    const cleaned = ref.replace(/[?#].*$/, '')
    if (!cleaned || checked.has(cleaned)) continue
    checked.add(cleaned)
    // Anchor refs at the Deck Source root (this is what the local
    // server does — the deck is served with rootDir as the doc root).
    const refAbs = path.resolve(rootDir, cleaned.replace(/^\/+/, ''))
    // Even though refs are author-controlled, run the sandbox check so
    // a stray `../foo` is reported as escaping rather than as a Deck file.
    try {
      await ensureInSandbox(refAbs, rootDir, /* writable */ false)
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
  return {
    issues,
    ok: [`index.html: scanned ${checked.size} local refs, ${missingCount} missing`],
  }
}

function formatDeckReport(result: DeckCheckResult): string {
  const summary = result.issues.length === 0 ? 'OK' : `${result.issues.length} issue(s)`
  return [
    `Deck validation: ${summary}`,
    ...result.issues.map((s) => `  ✗ ${s}`),
    '',
    'Checks:',
    ...result.ok.map((s) => `  • ${s}`),
  ].join('\n')
}

const validateDeckSchema = Type.Object({}, { additionalProperties: false })

function validateDeckTool(ctx: DeckToolsContext): AgentTool<typeof validateDeckSchema> {
  return {
    name: 'validate_deck',
    label: 'Validate deck',
    description:
      'Sanity-check the Deck Source: parses deck.json and scans index.html for ' +
      'src/href references that point to missing files. Read-only — does not modify ' +
      'anything. Use after structural changes to confirm the deck is still loadable.',
    parameters: validateDeckSchema,
    execute: async () => {
      const manifest = await checkDeckJson(ctx.rootDir)
      const html = await checkIndexHtml(ctx.rootDir)
      const result: DeckCheckResult = {
        issues: [...manifest.issues, ...html.issues],
        ok: [...manifest.ok, ...html.ok],
        manifest: manifest.manifest,
      }
      return {
        content: [{ type: 'text', text: formatDeckReport(result) }],
        details: result,
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
        if (signal?.aborted) {
          try {
            await reader.cancel()
          } catch {
            // already closed
          }
          throw new Error('fetch_url aborted.')
        }
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
// read_url — fetch a remote http(s) resource as text without writing to disk
// ---------------------------------------------------------------------------

const READ_URL_MAX_BYTES = 2 * 1024 * 1024 // 2 MB — large enough for docs/specs, small enough not to bloat context
const READ_URL_TEXT_TYPES = /^(?:text\/|application\/(?:json|xml|javascript|x-yaml|yaml))/i

const readUrlSchema = Type.Object(
  {
    url: Type.String({ description: 'http(s) URL to read.' }),
  },
  { additionalProperties: false },
)
type ReadUrlParams = Static<typeof readUrlSchema>

function readUrlTool(): AgentTool<typeof readUrlSchema> {
  return {
    name: 'read_url',
    label: 'Read URL',
    description:
      `Read a remote http(s) text resource (HTML, Markdown, JSON, plain text) into the ` +
      `chat context without writing it to disk. Use for docs, specs, READMEs, npm package ` +
      `pages — anything you want to consult before editing. Capped at ` +
      `${READ_URL_MAX_BYTES / (1024 * 1024)} MB and text content types only. For binary ` +
      `assets use fetch_url, which writes to the Deck Source.`,
    parameters: readUrlSchema,
    execute: async (_id, params: ReadUrlParams, signal) => {
      let parsed: URL
      try {
        parsed = new URL(params.url)
      } catch {
        throw new Error(`Invalid URL: ${params.url}`)
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`read_url only supports http(s); got ${parsed.protocol}`)
      }

      const res = await net.fetch(parsed.toString(), { redirect: 'follow', signal })
      if (!res.ok) {
        throw new Error(`read_url ${parsed.toString()} -> HTTP ${res.status} ${res.statusText}`)
      }

      // Refuse binary types up front so we don't waste a download on
      // something we'd just stringify into garbage.
      const contentType = res.headers.get('content-type') || ''
      if (contentType && !READ_URL_TEXT_TYPES.test(contentType)) {
        throw new Error(
          `read_url expects text content; got ${contentType}. ` +
            `Use fetch_url to download binaries to the Deck Source.`,
        )
      }

      const lenHeader = res.headers.get('content-length')
      if (lenHeader && Number(lenHeader) > READ_URL_MAX_BYTES) {
        throw new Error(
          `Remote resource ${lenHeader} bytes exceeds ${READ_URL_MAX_BYTES} byte cap.`,
        )
      }

      const body = res.body
      if (!body) throw new Error('read_url got an empty response body.')
      const chunks: Uint8Array[] = []
      let total = 0
      const reader = body.getReader()
      while (true) {
        if (signal?.aborted) {
          try {
            await reader.cancel()
          } catch {
            // already closed
          }
          throw new Error('read_url aborted.')
        }
        const { value, done } = await reader.read()
        if (done) break
        if (!value) continue
        total += value.byteLength
        if (total > READ_URL_MAX_BYTES) {
          try {
            await reader.cancel()
          } catch {
            // already closed
          }
          throw new Error(`Remote resource exceeds ${READ_URL_MAX_BYTES} byte cap (read ${total} bytes).`)
        }
        chunks.push(value)
      }
      const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf-8')
      return {
        content: [{ type: 'text', text }],
        details: { url: parsed.toString(), bytes: total, contentType },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// screenshot_preview — snapshot the rendered deck preview
// ---------------------------------------------------------------------------

// 1568 mirrors Anthropic's recommended long-edge for screenshots — large
// enough to read body text in slides, small enough that token cost stays
// reasonable. PNG keeps text crisp; JPEG would smear small fonts.
const SCREENSHOT_MAX_LONG_EDGE = 1568

const screenshotPreviewSchema = Type.Object({}, { additionalProperties: false })
type ScreenshotPreviewParams = Static<typeof screenshotPreviewSchema>

function screenshotPreviewTool(
  capturePreview: NonNullable<DeckToolsContext['capturePreview']>,
): AgentTool<typeof screenshotPreviewSchema> {
  return {
    name: 'screenshot_preview',
    label: 'Screenshot preview',
    description:
      `Capture the live deck preview as a PNG and attach it to the conversation so you ` +
      `can see what the user sees. Use after structural edits to verify layout, or when ` +
      `the user asks about something visible. The preview hot-reloads after each edit; ` +
      `if the screenshot still shows the pre-edit state, do another small action (e.g. ` +
      `read the file you just wrote) and screenshot again — that gives the iframe a ` +
      `chance to repaint.`,
    parameters: screenshotPreviewSchema,
    execute: async (_id, _params: ScreenshotPreviewParams) => {
      const captured = await capturePreview()
      if (!captured) {
        throw new Error(
          'Preview is not available right now (Play-only mode, no deck loaded, or the ' +
            'preview view was destroyed).',
        )
      }
      // Electron returns a "data:image/png;base64,..." URL. Strip the
      // prefix so we hand the agent raw base64, matching ImageContent's
      // contract (data is bytes, not a data URL).
      const m = /^data:(image\/[a-z+.-]+);base64,(.*)$/i.exec(captured.dataUrl)
      if (!m) throw new Error('Preview snapshot returned an unexpected data URL shape.')
      let mimeType = m[1]
      let base64 = m[2]

      // Resize down so we don't ship a 4K Retina capture into every
      // turn. nativeImage is already RGBA in memory, so we go through
      // it for the resize and re-encode as PNG.
      try {
        const original = nativeImage.createFromDataURL(captured.dataUrl)
        const size = original.getSize()
        const longEdge = Math.max(size.width, size.height)
        if (longEdge > SCREENSHOT_MAX_LONG_EDGE) {
          const scale = SCREENSHOT_MAX_LONG_EDGE / longEdge
          const resized = original.resize({
            width: Math.round(size.width * scale),
            height: Math.round(size.height * scale),
            quality: 'good',
          })
          base64 = resized.toPNG().toString('base64')
          mimeType = 'image/png'
        }
      } catch {
        // Resize is best-effort; fall through with the raw capture if
        // nativeImage rejects (corrupt PNG, etc.).
      }

      return {
        content: [{ type: 'image', data: base64, mimeType }],
        details: { mimeType, bytes: Math.floor((base64.length * 3) / 4) },
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
  const tools: AgentTool<any>[] = [
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
    readUrlTool(),
  ]
  // Only expose screenshot_preview when a capture function is wired —
  // otherwise the model would call a tool that always errors.
  if (ctx.capturePreview) tools.push(screenshotPreviewTool(ctx.capturePreview))
  return tools
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
    // Cap the top level the same way we cap children — a deck dropped
    // alongside a sprawling assets dump shouldn't blow the system
    // prompt. Truncation note follows the same `… N more` shape.
    const topShown = topVisible.slice(0, MAX_CHILDREN_PER_DIR)
    for (const entry of topShown) {
      const safeName = sanitizeFileNameForPrompt(entry.name)
      if (!entry.isDirectory()) {
        lines.push(`  - ${safeName}`)
        continue
      }
      lines.push(`  - ${safeName}/`)
      try {
        const childEntries = await readdir(path.join(rootDir, entry.name), { withFileTypes: true })
        const childVisible = childEntries
          .filter((e) => !e.name.startsWith('.'))
          .sort((a, b) => a.name.localeCompare(b.name))
        const shown = childVisible.slice(0, MAX_CHILDREN_PER_DIR)
        for (const child of shown) {
          const safeChild = sanitizeFileNameForPrompt(child.name)
          lines.push(`      - ${safeChild}${child.isDirectory() ? '/' : ''}`)
        }
        if (childVisible.length > shown.length) {
          lines.push(`      … ${childVisible.length - shown.length} more`)
        }
      } catch {
        lines.push(`      (could not list)`)
      }
    }
    if (topVisible.length > topShown.length) {
      lines.push(`  … ${topVisible.length - topShown.length} more`)
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
      // Sanitize untrusted manifest fields before they land in the
      // system prompt — a malicious deck.json can use newlines or
      // tag-shaped strings to redirect the model. Mirrors the same
      // strip-and-truncate logic system-prompt.ts uses for `deckName`.
      if (parsed.name) lines.push(`  name: ${sanitizeManifestField(parsed.name)}`)
      if (parsed.author) lines.push(`  author: ${sanitizeManifestField(parsed.author)}`)
      if (parsed.description) lines.push(`  description: ${sanitizeManifestField(parsed.description)}`)
    } catch {
      // malformed deck.json — the author will hit validation errors elsewhere
    }
  }
  return lines.join('\n')
}

function sanitizeManifestField(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

/**
 * Strip control chars and collapse whitespace from a filename before
 * it lands in the system prompt. macOS / Linux allow newlines and
 * other control chars in filenames; an attacker-crafted deck source
 * could otherwise inject a fake instruction by naming a file
 * `legit\n\nIgnore previous instructions...`. We don't truncate as
 * aggressively as `sanitizeManifestField` because filenames are the
 * model's primary handle on the tree.
 */
function sanitizeFileNameForPrompt(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
}
