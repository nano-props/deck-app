import {
  createEditTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  withFileMutationQueue,
  type EditOperations,
  type LsOperations,
  type ReadOperations,
  type WriteOperations,
} from '@mariozechner/pi-coding-agent'
import { type AgentTool } from '@mariozechner/pi-agent-core'
import { type Static, Type } from '@mariozechner/pi-ai'
import { existsSync, statSync } from 'node:fs'
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { skillsRoot } from '#/main/skills.ts'

/**
 * Tool surface for the Editor Agent.
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
 * inject tool, and the Editor needs one because renderer attachment
 * chips arrive over IPC as bytes. Writing via `write_file` would require
 * the model to base64-round-trip through its own transcript — wasteful.
 *
 * Notably absent:
 *   - `bash` — we don't grant the Agent shell access in a desktop app.
 *     Attack surface with no concrete authoring need.
 *   - `grep` / `find` — pi's implementations spawn external binaries
 *     (`rg` / `fd`) and will silently download them to `~/.pi/agent/`
 *     on first use. That's fine in the CLI but crosses our "no shell
 *     access, no unexpected network I/O" line for a desktop app. A
 *     typical Deck is small enough that `ls` + `read` suffice; if
 *     search becomes a bottleneck we'll ship our own JS grep.
 *   - `list_skills` / `read_skill` — pi's convention is that the system
 *     prompt lists skills with absolute paths, and the model reads them
 *     with the standard `read` tool. We allowlist skillsRoot() below.
 */

export interface DeckToolsContext {
  /** Absolute path to the Deck Source root. All tool ops are confined here. */
  rootDir: string
  /**
   * Optional notifier invoked after a tool mutates the Deck Source
   * (write / edit / add_asset). Used by the Editor to auto-reload the
   * preview iframe once the agent has finished editing. Path is relative
   * to rootDir when the write landed in the Deck; absolute otherwise
   * (shouldn't happen given sandbox, but the type is defensive).
   */
  onFileChange?: (relPath: string) => void
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

/** Return true if `abs` is `root` or inside `root` (no symlink escape). */
function isInside(abs: string, root: string): boolean {
  const a = path.resolve(abs)
  const r = path.resolve(root)
  return a === r || a.startsWith(r + path.sep)
}

/**
 * Reject any path that escapes the writable sandbox. `writable` controls
 * whether the bundled-skills allowlist applies — it does for read-only
 * ops (read / ls) but NOT for mutating ops (write / edit) because skills
 * are shipped content, not user-authorable.
 */
function ensureInSandbox(abs: string, rootDir: string, writable: boolean): void {
  if (isInside(abs, rootDir)) return
  if (!writable && isInside(abs, skillsRoot())) return
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
      ensureInSandbox(abs, rootDir, /* writable */ false)
      return readFile(abs)
    },
    access: async (abs) => {
      ensureInSandbox(abs, rootDir, /* writable */ false)
      await access(abs)
    },
    // pi's default detectImageMimeType opens the file with `fs.open` — it
    // happens to be called after `access` today, so our sandbox gate in
    // `access` catches escapes before it runs. Override here anyway so
    // the sandbox doesn't depend on pi's call order.
    detectImageMimeType: async (abs) => {
      ensureInSandbox(abs, rootDir, /* writable */ false)
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
      ensureInSandbox(abs, ctx.rootDir, /* writable */ true)
      await writeFile(abs, content, 'utf-8')
      const rel = toRelInsideRoot(abs, ctx.rootDir)
      if (rel !== null) ctx.onFileChange?.(rel)
    },
    mkdir: async (dir) => {
      ensureInSandbox(dir, ctx.rootDir, /* writable */ true)
      await mkdir(dir, { recursive: true })
    },
  }
}

function editOps(ctx: DeckToolsContext): EditOperations {
  return {
    // Same as writeOps: pi's edit tool holds the per-file mutex for
    // access+readFile+writeFile. Re-locking here would deadlock.
    readFile: async (abs) => {
      ensureInSandbox(abs, ctx.rootDir, /* writable */ true)
      return readFile(abs)
    },
    writeFile: async (abs, content) => {
      ensureInSandbox(abs, ctx.rootDir, /* writable */ true)
      await writeFile(abs, content, 'utf-8')
      const rel = toRelInsideRoot(abs, ctx.rootDir)
      if (rel !== null) ctx.onFileChange?.(rel)
    },
    access: async (abs) => {
      ensureInSandbox(abs, ctx.rootDir, /* writable */ true)
      await access(abs)
    },
  }
}

function lsOps(rootDir: string): LsOperations {
  return {
    exists: (abs) => {
      ensureInSandbox(abs, rootDir, /* writable */ false)
      return existsSync(abs)
    },
    stat: (abs) => {
      ensureInSandbox(abs, rootDir, /* writable */ false)
      return statSync(abs)
    },
    readdir: (abs) => {
      ensureInSandbox(abs, rootDir, /* writable */ false)
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
      const hasDir = params.path.includes('/')
      const rel = hasDir ? params.path : path.posix.join('assets', params.path)
      if (!path.extname(rel)) {
        throw new Error(`Asset filename needs an extension: ${params.path}`)
      }
      const abs = path.resolve(ctx.rootDir, rel)
      ensureInSandbox(abs, ctx.rootDir, /* writable */ true)
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
  return [
    createReadTool(rootDir, { operations: readOps(rootDir) }),
    createWriteTool(rootDir, { operations: writeOps(ctx) }),
    createEditTool(rootDir, { operations: editOps(ctx) }),
    createLsTool(rootDir, { operations: lsOps(rootDir) }),
    addAssetTool(ctx),
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
