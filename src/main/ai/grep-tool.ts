/**
 * Node-native grep tool — Schema-compatible with pi-coding-agent's `grep`.
 *
 * Why we don't use pi's grep: pi unconditionally calls `ensureTool('rg')`
 * which downloads ripgrep from GitHub on first use (see
 * pi-coding-agent/src/utils/tools-manager.ts). Even if we pass custom
 * `operations`, the rg spawn happens before they're consulted. Decks are
 * small projects (typically a few dozen files), so a Node-native scanner
 * is fast enough and lets us keep the "no surprise network I/O" rule.
 *
 * Schema parity is deliberate so prompt instructions and the agent's
 * tool-calling habits transfer 1:1 when a future pi version makes rg
 * optional and we can switch back. Result shape (`content` + `details`
 * with `matchLimitReached`/`truncation`/`linesTruncated`) also matches.
 */

import { type AgentTool } from '@earendil-works/pi-agent-core'
import { type Static, Type } from '@earendil-works/pi-ai'
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
  truncateLine,
  type TruncationResult,
} from '@earendil-works/pi-coding-agent'
import { readdir } from 'node:fs/promises'
import path from 'node:path'

const grepSchema = Type.Object({
  pattern: Type.String({ description: 'Search pattern (regex or literal string)' }),
  path: Type.Optional(
    Type.String({
      description:
        'Directory or file to search, relative to the deck root (e.g. "src" or "index.html"). Default: deck root.',
    }),
  ),
  glob: Type.Optional(
    Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" }),
  ),
  ignoreCase: Type.Optional(
    Type.Boolean({ description: 'Case-insensitive search (default: false)' }),
  ),
  literal: Type.Optional(
    Type.Boolean({ description: 'Treat pattern as literal string instead of regex (default: false)' }),
  ),
  context: Type.Optional(
    Type.Number({ description: 'Number of lines to show before and after each match (default: 0)' }),
  ),
  limit: Type.Optional(
    Type.Number({ description: 'Maximum number of matches to return (default: 100)' }),
  ),
})

type GrepParams = Static<typeof grepSchema>

interface GrepDetails {
  truncation?: TruncationResult
  matchLimitReached?: number
  linesTruncated?: boolean
}

const DEFAULT_LIMIT = 100
// Per-line cap. pi-coding-agent's `truncateLine` defaults to the same
// value (its private GREP_MAX_LINE_LENGTH = 500) so output looks the
// same as the rg-backed tool. We pass it explicitly to keep this file
// the source of truth — pi doesn't export the constant, so a future
// pi-side change wouldn't tear our description out of sync.
const MAX_LINE_LENGTH = 500

// Directory names we never descend into. Decks rarely contain any of
// these, but if a user dropped a `node_modules/` next to their deck for
// dev experiments, we still want grep to skip it. Exported so findOps
// in tools.ts uses the same set — keeping grep and find consistent.
export const IGNORED_DIRS: ReadonlySet<string> = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', '.next',
])

// Files we treat as binary by extension. Pi's rg auto-detects binary by
// scanning bytes for NUL — we can't do that reliably from a utf-8-decoded
// string (invalid bytes get replaced with U+FFFD, not preserved as NUL),
// so we lean on the extension list. Decks are authoring projects with
// well-known asset types; an unknown-extension binary slipping through
// just produces a noise-free regex pass on garbage text, not a crash.
const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tiff',
  '.mp4', '.webm', '.mov', '.avi', '.mkv',
  '.mp3', '.wav', '.ogg', '.flac', '.m4a',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.pdf', '.zip', '.tar', '.gz', '.7z', '.rar',
])

export interface GrepOps {
  /** Throws if path doesn't exist. */
  isDirectory: (abs: string) => Promise<boolean>
  readFile: (abs: string) => Promise<string>
}

export interface DeckGrepOptions {
  cwd: string
  operations: GrepOps
}

/**
 * Convert a glob pattern (e.g. `*.ts`, `**\/*.spec.ts`) to a RegExp that
 * matches against forward-slash POSIX paths. Supports `*`, `**`, `?`,
 * and character classes — everything else is escaped. Path-anchored
 * patterns ("contains a /") match against the full relative path;
 * basename patterns match against the filename only.
 *
 * Exported so `tools.ts` can reuse the same matcher for `findOps.glob`.
 */
export function compileGlob(pattern: string): { re: RegExp; anchored: boolean } {
  // Empty pattern would compile to /^$/, matching only an empty
  // filename — find/grep callers would get a baffling "no matches"
  // with no hint why. Reject explicitly so the model learns.
  if (pattern.length === 0) {
    throw new Error("Empty glob pattern. Use '*' to match everything, or omit the parameter.")
  }
  const anchored = pattern.includes('/')
  let re = ''
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**` — match any path segment(s) including separators
        re += '.*'
        i += 2
        // consume optional `/` after `**`
        if (pattern[i] === '/') i++
      } else {
        // `*` — match any chars except `/`
        re += '[^/]*'
        i++
      }
    } else if (c === '?') {
      re += '[^/]'
      i++
    } else if (c === '[') {
      // Pass through char class up to the matching `]`
      const end = pattern.indexOf(']', i)
      if (end === -1) {
        re += '\\['
        i++
      } else {
        re += pattern.slice(i, end + 1)
        i = end + 1
      }
    } else if ('.+^$(){}|\\'.includes(c)) {
      re += '\\' + c
      i++
    } else {
      re += c
      i++
    }
  }
  try {
    return { re: new RegExp('^' + re + '$'), anchored }
  } catch (e) {
    // Unbalanced/escaped char classes (e.g. `[\]]`) produce regex that
    // RegExp can't compile. Surface as a tool-level error rather than
    // letting SyntaxError tear down the agent loop.
    const reason = e instanceof Error ? e.message : String(e)
    throw new Error(
      `Invalid glob pattern '${pattern}': ${reason}. ` +
        `Supported syntax: '*' (no slash), '**' (any depth), '?' (single char), '[abc]' char class.`,
    )
  }
}

function buildPattern(input: string, opts: { ignoreCase?: boolean; literal?: boolean }): RegExp {
  // No 'g' flag — we only use .test, which is stateless without it.
  // Adding 'g' would force every call site to reset lastIndex.
  const flags = opts.ignoreCase ? 'i' : ''
  const source = opts.literal ? input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : input
  try {
    return new RegExp(source, flags)
  } catch (e) {
    // Surface invalid regex as a tool-level error instead of letting
    // SyntaxError bubble unaltered — pi's loop reports tool errors as a
    // single line in the chat. Tell the model what we got and how to retry.
    const reason = e instanceof Error ? e.message : String(e)
    throw new Error(
      `Invalid regex pattern: ${reason}. ` +
        `Pass literal=true to search for the pattern as a plain string.`,
    )
  }
}

/**
 * Stack-based directory walk yielding file paths. Skips dotfiles
 * (matches rg's `--hidden` off) and any directory in `ignored`.
 *
 * Exported so `findOps` in tools.ts can reuse it — both grep and find
 * want the same "search a deck-tree, skip noise" semantics, and sharing
 * the walk keeps their behavior locked together.
 */
export async function* walkFiles(
  root: string,
  ignored: ReadonlySet<string>,
): AsyncGenerator<string> {
  const stack: string[] = [root]
  while (stack.length) {
    const dir = stack.pop()!
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // Skip unreadable subdirs silently (permissions, vanished mid-walk).
      // If `root` itself is unreadable, the caller will see an empty
      // walk rather than an error — acceptable trade-off since deck
      // rootDirs are user-chosen and rarely have this problem.
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        if (ignored.has(entry.name)) continue
        stack.push(path.join(dir, entry.name))
      } else if (entry.isFile()) {
        yield path.join(dir, entry.name)
      }
    }
  }
}

function isLikelyBinary(absPath: string): boolean {
  const ext = path.extname(absPath).toLowerCase()
  return BINARY_EXTS.has(ext)
}

/**
 * Path relative to `root`, normalized to forward slashes. Falls back to
 * basename when filePath escapes root (e.g. when grep is pointed at a
 * skill file outside the deck) so output is never a `..`-laden path.
 */
function relPathFrom(root: string, filePath: string): string {
  const rel = path.relative(root, filePath)
  if (rel && !rel.startsWith('..')) return rel.replace(/\\/g, '/')
  return path.basename(filePath)
}

export function createDeckGrepTool(opts: DeckGrepOptions): AgentTool<typeof grepSchema> {
  const { cwd, operations } = opts
  return {
    name: 'grep',
    label: 'grep',
    description:
      `Search file contents for a pattern. Returns matching lines with file paths and line numbers. ` +
      `Pass 'path' as a deck-relative path (e.g. "src" or "index.html"). Don't reconstruct absolute filesystem paths even if you've seen one elsewhere — they may not match the deck's current location. ` +
      `Directory searches skip node_modules / .git / dotfiles / binaries by default. ` +
      `Single-file searches bypass those defaults so a deliberately named file is always read. ` +
      `The optional 'glob' parameter (e.g. '*.ts', '**/*.css') is always applied as an extra filter. ` +
      `Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). ` +
      `Long lines are truncated to ${MAX_LINE_LENGTH} chars.`,
    parameters: grepSchema,
    execute: async (_id, params: GrepParams, signal) => {
      if (signal?.aborted) throw new Error('Operation aborted')

      // path.resolve handles absolute paths correctly (returns them
      // verbatim, ignoring cwd) so no isAbsolute guard needed here.
      const searchPath = path.resolve(cwd, params.path ?? '.')

      let isDir: boolean
      try {
        isDir = await operations.isDirectory(searchPath)
      } catch (e) {
        // Distinguish "doesn't exist" from "sandbox refused": ENOENT is
        // a plain not-found, anything else (sandbox rejection, EACCES,
        // etc.) deserves its own message so the model isn't told a
        // forbidden path "doesn't exist". Echo the model's input rather
        // than `searchPath` (the resolved absolute) — the absolute path
        // is what tripped up the model in the first place; showing it
        // back doesn't help.
        const code = (e as NodeJS.ErrnoException | undefined)?.code
        if (code === 'ENOENT') throw new Error(`Path not found: ${params.path ?? '.'}`)
        throw e
      }

      const limit = Math.max(1, params.limit ?? DEFAULT_LIMIT)
      const ctxLines = params.context && params.context > 0 ? params.context : 0
      const matcher = buildPattern(params.pattern, {
        ignoreCase: params.ignoreCase,
        literal: params.literal,
      })
      const globRe = params.glob ? compileGlob(params.glob) : null

      // Output paths anchor at the search root for a dir walk; for a
      // single-file call we anchor at cwd so the model sees the same
      // relative path it passed in (`src/foo.ts:42:` rather than just
      // `foo.ts:42:`).
      const pathRoot = isDir ? searchPath : cwd
      const relPathOf = (filePath: string) => relPathFrom(pathRoot, filePath)

      const passesGlob = (filePath: string): boolean => {
        if (!globRe) return true
        const rel = relPathOf(filePath)
        const target = globRe.anchored ? rel : path.basename(rel)
        return globRe.re.test(target)
      }

      const outputLines: string[] = []
      let matchCount = 0
      let matchLimitReached = false
      let linesTruncated = false

      // Scan the file's contents and append matches. Caller is
      // responsible for filtering: this function trusts that filePath
      // should be searched. A user-supplied glob is checked here (it's
      // explicit intent, applies to both walk and single-file). The
      // binary-extension skip is the caller's call — directory walks
      // skip them as noise; an explicit single-file path searches them.
      const scan = async (filePath: string): Promise<void> => {
        if (signal?.aborted) throw new Error('Operation aborted')
        if (matchCount >= limit) return
        if (!passesGlob(filePath)) return

        let content: string
        try {
          content = await operations.readFile(filePath)
        } catch {
          return
        }

        // Single-pass split on any of CRLF / CR / LF — saves two
        // multi-MB string allocations vs. chained replace+split.
        const lines = content.split(/\r\n|\r|\n/)
        const relPath = relPathOf(filePath)
        // Track which line indices are matches (for `relPath:N:` vs
        // `relPath-N-` formatting) and how far we've already emitted in
        // this file (so overlapping context windows don't duplicate
        // lines — rg uses `--` separators; we just dedupe outright).
        const matchSet = new Set<number>()
        for (let i = 0; i < lines.length; i++) {
          if (matcher.test(lines[i])) matchSet.add(i)
        }
        if (matchSet.size === 0) return

        let lastEmitted = -1
        for (const i of matchSet) {
          // A match swallowed by the previous match's trailing context
          // already shows up in the output (with `:` formatting from
          // matchSet); don't count it against the limit a second time.
          if (i <= lastEmitted) continue
          if (matchCount >= limit) break
          matchCount++
          if (ctxLines === 0) {
            const { text, wasTruncated } = truncateLine(lines[i], MAX_LINE_LENGTH)
            if (wasTruncated) linesTruncated = true
            outputLines.push(`${relPath}:${i + 1}: ${text}`)
            lastEmitted = i
          } else {
            const start = Math.max(lastEmitted + 1, i - ctxLines)
            const end = Math.min(lines.length - 1, i + ctxLines)
            for (let j = start; j <= end; j++) {
              const { text, wasTruncated } = truncateLine(lines[j], MAX_LINE_LENGTH)
              if (wasTruncated) linesTruncated = true
              const isMatch = matchSet.has(j)
              outputLines.push(isMatch ? `${relPath}:${j + 1}: ${text}` : `${relPath}-${j + 1}- ${text}`)
            }
            lastEmitted = end
          }
        }
        if (matchCount >= limit) matchLimitReached = true
      }

      if (isDir) {
        for await (const file of walkFiles(searchPath, IGNORED_DIRS)) {
          if (signal?.aborted) throw new Error('Operation aborted')
          if (isLikelyBinary(file)) continue
          await scan(file)
          if (matchCount >= limit) break
        }
      } else {
        // Single-file search: the model named this file deliberately,
        // so we don't apply the binary-extension skip. A deliberately
        // searched .png produces (probably noisy) results rather than
        // a silent empty.
        await scan(searchPath)
      }

      if (matchCount === 0) {
        return { content: [{ type: 'text', text: 'No matches found' }], details: undefined }
      }

      const raw = outputLines.join('\n')
      // Apply byte truncation. No line-count limit here — the match limit
      // already bounded row count.
      const truncation = truncateHead(raw, { maxLines: Number.MAX_SAFE_INTEGER })
      let output = truncation.content
      const details: GrepDetails = {}
      const notices: string[] = []
      if (matchLimitReached) {
        notices.push(
          `${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`,
        )
        details.matchLimitReached = limit
      }
      if (truncation.truncated) {
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`)
        details.truncation = truncation
      }
      if (linesTruncated) {
        notices.push(
          `Some lines truncated to ${MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
        )
        details.linesTruncated = true
      }
      if (notices.length > 0) output += `\n\n[${notices.join('. ')}]`

      return {
        content: [{ type: 'text', text: output }],
        details: Object.keys(details).length > 0 ? details : undefined,
      }
    },
  }
}
