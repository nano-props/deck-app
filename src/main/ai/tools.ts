import {
  createBashTool,
  createEditTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  withFileMutationQueue,
  type EditOperations,
  type LsOperations,
  type ReadOperations,
  type WriteOperations,
} from '@earendil-works/pi-coding-agent'
import { type AgentTool } from '@earendil-works/pi-agent-core'
import { type Static, Type } from '@earendil-works/pi-ai'
import { existsSync, statSync } from 'node:fs'
import { access, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createSandboxedBashOperations, isBashSandboxAvailable } from '#/main/ai/sandbox/bash-sandbox.ts'
import { skillsRoot } from '#/main/skills.ts'

/**
 * Tool surface for the Edit sub-view's Agent.
 *
 * We use pi-coding-agent's tool factories (read / write / edit / ls)
 * rather than hand-rolling them — they're the same tools the `pi` CLI
 * ships, so the prompt behavior and tool-calling ergonomics are
 * well-exercised. Every factory takes an `operations` object; we plug
 * in a *sandboxed* implementation that rejects any path outside the
 * Deck Source (plus a read-only allowlist for the bundled skills
 * directory, so the model can read SKILL.md by its absolute path).
 *
 * One Deck-specific tool remains: `add_asset`. pi has no base64 binary
 * inject tool, and we need one because renderer attachment chips arrive
 * over IPC as bytes. Writing via `write_file` would require the model
 * to base64-round-trip through its own transcript — wasteful.
 *
 * Optional `bash` (off by default, opt-in via Settings → Enable bash):
 *   When enabled on macOS we register a bash tool that runs every
 *   command through `sandbox-exec` with read-anywhere /
 *   write-only-in-rootDir / no-network. That's strict enough that an
 *   adversarial command from the model can't exfiltrate or persist
 *   state outside the deck source, while still letting the agent
 *   reach for `sed`, `awk`, ImageMagick, etc. when scripted edits are
 *   easier than hand-rolling a tool. Linux/Windows currently get no
 *   bash — sandbox-exec is darwin-only and we don't ship an
 *   equivalent yet.
 *
 * Notably absent:
 *   - `grep` / `find` — pi's implementations spawn external binaries
 *     (`rg` / `fd`) and will silently download them to `~/.pi/agent/`
 *     on first use. That's fine in the CLI but crosses our "no
 *     unexpected network I/O" line for a desktop app. With bash on,
 *     the agent can still run `grep -r` / `find` against the deck
 *     inside the sandbox.
 *   - `list_skills` / `read_skill` — pi's convention is that the system
 *     prompt lists skills with absolute paths, and the model reads them
 *     with the standard `read` tool. We allowlist skillsRoot() below.
 */

export interface DeckToolsContext {
  /** Absolute path to the Deck Source root. All tool ops are confined here. */
  rootDir: string
  /**
   * Optional notifier invoked after a tool mutates the Deck Source
   * (write / edit / add_asset). Used by the Edit sub-view to auto-reload
   * the preview once the agent has finished editing. Path is relative
   * to rootDir when the write landed in the Deck; absolute otherwise
   * (shouldn't happen given sandbox, but the type is defensive).
   */
  onFileChange?: (relPath: string) => void
  /**
   * Register the optional `bash` tool. Caller is expected to pass the
   * *effective* gate (user opted in AND the OS supports the sandbox);
   * we still re-check `isBashSandboxAvailable()` defensively so a
   * misuse here can't bypass the isolation. See bash-sandbox.ts for
   * the profile. Note: bash bypasses our `onFileChange` notifier —
   * chokidar picks bash-driven writes up via the watcher path instead,
   * so the preview still reloads (with the watcher's normal debounce).
   */
  enableBash?: boolean
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
 * whether the bundled-skills allowlist applies — it does for read-only
 * ops (read / ls) but NOT for mutating ops (write / edit) because skills
 * are shipped content, not user-authorable.
 *
 * We resolve `abs` AND each allowed root through `realpath` so symlinks
 * within the Deck Source can't be used to escape.
 */
async function ensureInSandbox(abs: string, rootDir: string, writable: boolean): Promise<void> {
  // Cheap string prefix first — catches `..` traversal before any I/O.
  if (!isInsideString(abs, rootDir) && !(!writable && isInsideString(abs, skillsRoot()))) {
    throw new Error(`Path escapes the Deck sandbox: ${abs}`)
  }
  const real = await realpathSafe(abs)
  const realRoot = await realpathSafe(rootDir)
  if (isInsideString(real, realRoot)) return
  if (!writable) {
    const realSkills = await realpathSafe(skillsRoot())
    if (isInsideString(real, realSkills)) return
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
      const rel = toRelInsideRoot(abs, ctx.rootDir)
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
      const rel = toRelInsideRoot(abs, ctx.rootDir)
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
      const RESERVED = new Set(['deck.json', 'index.html'])
      const relPosix = rel.split(path.sep).join('/')
      if (RESERVED.has(relPosix)) {
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
    addAssetTool(ctx),
  ]
  if (ctx.enableBash && isBashSandboxAvailable()) {
    // Profile construction can fail if rootDir contains characters that
    // can't safely live inside a sandbox-exec literal (parens, quotes,
    // etc.). We don't want that to take down the whole session — just
    // log and skip the bash tool. The agent loses bash but keeps
    // read/write/edit/ls/add_asset.
    try {
      tools.push(
        createBashTool(rootDir, {
          operations: createSandboxedBashOperations({ writableRoot: rootDir }),
        }),
      )
    } catch (err) {
      console.warn('[ai] bash tool disabled — could not build sandbox profile:', err)
    }
  }
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
