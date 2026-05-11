/**
 * Sandbox layer — the bottleneck through which every tool path goes.
 *
 * Each tool execute handler resolves the user-supplied path against the
 * deck root via `resolveSandboxPath`, OR delegates to one of the ops
 * factories in `ops.ts` whose individual operations are wrapped by the
 * `sandboxed` HOF defined here. Either way, no fs access happens before
 * containment is verified.
 *
 * Two-step containment: a fast string-prefix check (`isInsideString`)
 * filters obvious cases, then a realpath comparison handles symlinks
 * and macOS path aliases (e.g. `/var` → `/private/var`). Skill dirs
 * are an additional read-only allowlist for the model to load published
 * SKILL.md files via absolute paths.
 *
 * Module-level state: `realpathRootCache` memoizes realpath results for
 * trusted roots (deck rootDir + skill dirs). Per-process, never reset —
 * the keys are absolute paths, so concurrent sessions on different
 * decks don't collide. Resetting would force a fresh syscall on every
 * tool call (read/grep/find can fire hundreds of times per turn).
 */
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { editorSkillRoots } from '#/main/skills.ts'

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
 * Resolve and validate a path against the Deck sandbox. `writable` controls
 * whether the Editor-visible skill allowlist applies — it does for
 * read-only ops (read / ls) but NOT for mutating ops (write / edit)
 * because skills are shipped content, not user-authorable.
 *
 * The candidate path goes through `realpath` fresh (it can be a brand-
 * new file the model is about to create); the trusted roots are cached
 * (see `realpathRootCached`). We intentionally avoid rejecting on raw
 * string prefixes before realpath: macOS commonly aliases `/var` to
 * `/private/var`, so a path can look outside `rootDir` as a string while
 * still resolving inside the same Deck Source.
 */
export async function resolveSandboxPath(
  abs: string,
  rootDir: string,
  writable: boolean,
): Promise<{ relPath: string | null }> {
  const allowedReadRoots = writable ? [] : editorSkillRoots()
  const real = await realpathSafe(abs)
  const realRoot = await realpathRootCached(rootDir)
  if (isInsideString(real, realRoot)) {
    return { relPath: toRelPosixFromResolved(real, realRoot) }
  }
  if (!writable) {
    for (const root of allowedReadRoots) {
      const realAllowedRoot = await realpathRootCached(root)
      if (isInsideString(real, realAllowedRoot)) {
        return { relPath: null }
      }
    }
  }
  throw new Error(`Path escapes the Deck sandbox: ${abs}`)
}

export function toRelPosixFromResolved(abs: string, rootDir: string): string | null {
  const rel = toRelInsideRoot(abs, rootDir)
  if (rel === null) return null
  return rel.split(path.sep).join('/')
}

export function toRelInsideRoot(abs: string, rootDir: string): string | null {
  const a = path.resolve(abs)
  const r = path.resolve(rootDir)
  if (a === r) return ''
  if (a.startsWith(r + path.sep)) return path.relative(r, a)
  return null
}

/**
 * Wrap an `(abs, ...) => R` function so it gates on `resolveSandboxPath`
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
export function sandboxed<A extends unknown[], R>(
  rootDir: string,
  writable: boolean,
  fn: (abs: string, ...rest: A) => R | Promise<R>,
): (abs: string, ...rest: A) => Promise<R> {
  return async (abs, ...rest) => {
    await resolveSandboxPath(abs, rootDir, writable)
    return fn(abs, ...rest)
  }
}
