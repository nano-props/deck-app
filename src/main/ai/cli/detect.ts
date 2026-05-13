import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface ClaudeCliDetection {
  found: boolean
  /** Resolved binary name (we rely on PATH; the user's shell alias from
   *  e.g. .zshrc isn't visible because Electron spawns commands without
   *  a login shell). When `found` is true this is just the canonical
   *  `claude` name — surface it so the UI can render "found `claude`" */
  bin?: string
  /** Trimmed first line of `claude --version` output. Free-form string
   *  the CLI controls — we display it as-is. */
  version?: string
  /** Human-readable failure reason when `found` is false. */
  error?: string
}

/**
 * Locate the `claude` CLI on the user's system.
 *
 * Detection runs `claude --version` via `execFile` with the parent
 * environment passed through. We intentionally do NOT shell out through
 * `bash -lc` to pick up shell aliases / rc-file PATH munging — Electron
 * already surfaces the GUI app's PATH (the same one Finder-launched apps
 * see), and adding a login-shell wrapper would silently let users alias
 * `claude` to something arbitrary.
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
    const { stdout } = await execFileAsync('claude', ['--version'], { timeout: 5_000 })
    const version = stdout.split('\n')[0]?.trim()
    return { found: true, bin: 'claude', version }
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    // ENOENT = not on PATH. Anything else (timeout, permission) is still
    // a "not usable" outcome from the user's perspective; we report the
    // raw message so they can debug.
    if (err.code === 'ENOENT') {
      return { found: false, error: 'claude not found on PATH' }
    }
    return { found: false, error: err.message || String(e) }
  }
}
