import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { enhancedPath } from '#/main/ai/cli/path.ts'

const execFileAsync = promisify(execFile)

export interface ClaudeCliDetection {
  found: boolean
  /** Canonical command name we invoke (`claude`). Not an absolute path
   *  — `execFile` / `spawn` re-walk PATH each call. */
  bin?: string
  /** Trimmed first line of `claude --version` output. Free-form string
   *  the CLI controls — we display it as-is. */
  version?: string
  /** Free-form failure detail for unexpected errors (timeout, permission,
   *  ...). Left undefined for the common ENOENT case so the renderer can
   *  fall back to its i18n'd "not found" string instead of showing a
   *  hardcoded English message. */
  error?: string
}

/**
 * Locate the `claude` CLI on the user's system.
 *
 * Detection runs `claude --version` via `execFile` against an augmented
 * PATH (see `enhancedPath`) — the GUI app's process PATH from Finder /
 * Dock / `open` is the minimal `/usr/bin:/bin:...` that launchd hands
 * out, which doesn't include any of the locations Claude Code actually
 * installs into. We do NOT shell out through `bash -lc`: that picks up
 * shell aliases and lets the user silently re-shape how we invoke the
 * CLI.
 *
 * Cached for the lifetime of the main process: detection is cheap but
 * not free (~50ms cold), and `checkAiReadiness` runs on every send.
 * The cache is invalidated explicitly via `invalidateClaudeCliDetection`
 * — currently only the Settings "Re-check" button calls it; first install
 * during a session would otherwise stay invisible until restart.
 */
let cachedDetection: Promise<ClaudeCliDetection> | null = null

export function invalidateClaudeCliDetection(): void {
  cachedDetection = null
}

export function detectClaudeCli(): Promise<ClaudeCliDetection> {
  if (!cachedDetection) cachedDetection = doDetect()
  return cachedDetection
}

async function doDetect(): Promise<ClaudeCliDetection> {
  try {
    // 5s timeout — the binary should respond instantly. If it doesn't,
    // assume something is wrong (hung process, broken install) and treat
    // as not found rather than blocking the user's send button forever.
    const { stdout } = await execFileAsync('claude', ['--version'], {
      timeout: 5_000,
      env: { ...process.env, PATH: enhancedPath() },
    })
    const version = stdout.split('\n')[0]?.trim()
    return { found: true, bin: 'claude', version }
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    // ENOENT = not on PATH. Anything else (timeout, permission) is still
    // a "not usable" outcome from the user's perspective; we report the
    // raw message so they can debug.
    if (err.code === 'ENOENT') {
      // PATH here is the augmented one — see `enhancedPath`. Common case;
      // leave `error` undefined so the renderer renders its i18n'd
      // `settings.cli.notFound` instead of a hardcoded English string.
      return { found: false }
    }
    return { found: false, error: err.message || String(e) }
  }
}
