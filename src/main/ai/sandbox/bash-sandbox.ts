/**
 * macOS sandbox-exec wrapper for the bash tool.
 *
 * Why this file exists:
 *   pi's bash tool runs arbitrary shell commands. Letting an LLM agent
 *   pipe `curl x | sh` against the user's machine is unacceptable — but
 *   bash is also the only practical way an agent can do things like
 *   `convert input.png -resize 800x output.png` against deck assets.
 *   Apple's `sandbox-exec` lets us run a child process with deny-by-
 *   default permissions and an allowlist for (a) read-anywhere (so
 *   tools like `cat /usr/share/...`, `which`, `ls /` work for
 *   diagnostics), (b) write-only-inside the deck rootDir, (c) no
 *   network. That's enough to keep an exfiltration- or destruction-
 *   prone command from doing damage even if the agent issues one.
 *
 * Important caveats:
 *   - `sandbox-exec` has been marked "deprecated" by Apple for years
 *     but is still shipped and works on every macOS through Sequoia.
 *     If a future macOS removes it, this whole module breaks; the
 *     bash tool falls back to a hard-deny (see `isBashSandboxAvailable`).
 *   - macOS only. Linux/Windows callers get a refusal — bash is just
 *     not enabled on those platforms today.
 *   - The sandbox is *file/network-level*, not capability-level. A
 *     command can still spawn long-running processes, fork-bomb, or
 *     exhaust CPU. We mitigate via a hard timeout and process-tree kill.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { BashOperations } from '@earendil-works/pi-coding-agent'

/**
 * `system.sb` is a profile bundled with macOS that allowlists the basic
 * Mach lookups, sysctls, and IPC every shell command needs. Importing
 * it saves us writing 100+ lines of low-level allow rules and tracking
 * them per macOS release. Path is stable across versions we care about.
 */
const SYSTEM_PROFILE = '/System/Library/Sandbox/Profiles/system.sb'
const SANDBOX_EXEC = '/usr/bin/sandbox-exec'

export function isBashSandboxAvailable(): boolean {
  return process.platform === 'darwin' && existsSync(SANDBOX_EXEC) && existsSync(SYSTEM_PROFILE)
}

/**
 * Build a sandbox-exec profile that grants read everywhere + write only
 * inside `writableRoot`, denies all network. `/tmp` on macOS is a
 * symlink to `/private/tmp` and `/var` to `/private/var` — when the
 * deck rootDir lives under those, we add both forms so the rule
 * matches regardless of which path the tool actually opens.
 *
 * SBPL is a Lisp-like dialect with `"`-quoted strings (no string
 * interpolation, no escape syntax we can rely on cross-version). We
 * reject any rootDir with characters that could break out of the
 * literal — `"` could close the string, `\` could escape it, parens
 * would unbalance the form, control chars terminate the line. A path
 * we can't safely embed throws here; the caller (`createDeckTools`)
 * sees the throw and skips registering the bash tool, which is the
 * fail-closed behavior we want.
 */
function buildProfile(writableRoot: string): string {
  const abs = path.resolve(writableRoot)
  // Disallow anything that could break out of `"..."` or unbalance the
  // S-expression: control chars, quotes, backslash, parens. We check
  // the resolved path because that's what we actually embed — checking
  // the raw input would let `path.resolve` later prepend a cwd
  // containing forbidden chars (rare in practice, but free to handle).
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f"\\()]/.test(abs)) {
    throw new Error(`Deck rootDir is not safe to embed in a sandbox profile: ${abs}`)
  }
  const privateTwin =
    abs === '/tmp' || abs.startsWith('/tmp/') || abs === '/var' || abs.startsWith('/var/')
      ? `/private${abs}`
      : null
  const writeRules = [`(allow file-write* (subpath "${abs}"))`]
  if (privateTwin) writeRules.push(`(allow file-write* (subpath "${privateTwin}"))`)
  return [
    '(version 1)',
    '(deny default)',
    `(import "${SYSTEM_PROFILE}")`,
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow file-read*)',
    ...writeRules,
    '(deny network*)',
  ].join('\n')
}

export interface SandboxedBashOptions {
  /** Path the command may write to; reads are unrestricted. */
  writableRoot: string
  /** Hard wall-clock timeout in ms. Forwarded to spawn `signal`. */
  defaultTimeoutMs?: number
}

/**
 * Build a `BashOperations` impl that wraps every command in
 * `sandbox-exec -p <profile> /bin/bash -c <command>`. Drop-in
 * replacement for pi's `createLocalBashOperations` — same signature,
 * just sandboxed.
 */
export function createSandboxedBashOperations(opts: SandboxedBashOptions): BashOperations {
  if (!isBashSandboxAvailable()) {
    throw new Error('Bash sandbox is only available on macOS with sandbox-exec.')
  }
  const profile = buildProfile(opts.writableRoot)
  const HARD_TIMEOUT_MS = opts.defaultTimeoutMs ?? 60_000
  return {
    exec: (command, cwd, { onData, signal, timeout, env }) => {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error('Aborted'))
          return
        }
        if (!existsSync(cwd)) {
          reject(new Error(`Working directory does not exist: ${cwd}`))
          return
        }
        // Defense in depth: if the model passes a cwd that escapes
        // writableRoot, the sandbox would still block writes — but
        // also reject early so the error message is clear.
        const absCwd = path.resolve(cwd)
        const absRoot = path.resolve(opts.writableRoot)
        if (absCwd !== absRoot && !absCwd.startsWith(absRoot + path.sep)) {
          reject(new Error(`Bash cwd must be inside the deck source: ${cwd}`))
          return
        }
        // pi's tool passes `timeout` in seconds (or undefined → none).
        // We always cap at HARD_TIMEOUT_MS regardless, to keep a hung
        // command from pinning the agent loop forever.
        const requestedMs =
          typeof timeout === 'number' && Number.isFinite(timeout) ? timeout * 1000 : HARD_TIMEOUT_MS
        const effectiveMs = Math.min(requestedMs, HARD_TIMEOUT_MS)

        const child = spawn(
          SANDBOX_EXEC,
          ['-p', profile, '/bin/bash', '-c', command],
          {
            cwd: absCwd,
            env: env ?? process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            // `detached: true` puts the child in its own process group so
            // we can SIGKILL the whole tree (including grandchildren the
            // shell forks) by signalling -pid. Without this a runaway
            // tool like `yes` started from `bash -c 'yes &'` would
            // outlive the bash parent and stdio would stay open,
            // hanging the close event.
            detached: true,
          },
        )

        // Kill the whole process group (sandbox-exec + bash + any
        // grandchildren it forked). Negative pid signals the group.
        // We swallow ESRCH — the group can already be gone.
        const killTree = () => {
          if (!child.pid) return
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch {
            // group already gone, or never made it (spawn error)
          }
        }

        const timer = setTimeout(killTree, effectiveMs)

        const onAbort = () => killTree()
        // Re-check `aborted`: it may have flipped between the early
        // bail-out at the top of this Promise and the moment we
        // register the listener (the abort fires synchronously the
        // instant `agent.abort()` runs, and that can interleave with
        // our spawn). Without this check the listener wouldn't fire
        // for an already-aborted signal.
        if (signal?.aborted) onAbort()
        else signal?.addEventListener('abort', onAbort, { once: true })

        child.stdout.on('data', (d: Buffer) => onData(d))
        child.stderr.on('data', (d: Buffer) => onData(d))
        child.on('error', (err) => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          reject(err)
        })
        // Reap any background grandchildren the moment the shell itself
        // exits. Without this, a command like `yes >/dev/null & exit 0`
        // returns exitCode=0 but the orphaned `yes` keeps stdout open,
        // so `'close'` doesn't fire until the hard timeout. Killing the
        // group on `exit` lets `'close'` settle promptly. The exit code
        // is captured here too because `'close'` may arrive with `null`
        // after the SIGKILL we just issued.
        let exitCode: number | null = null
        let exited = false
        child.on('exit', (code) => {
          exited = true
          exitCode = code
          // Tear down anything still in the group. If the shell exited
          // cleanly with no leftovers this is a no-op.
          killTree()
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          // Prefer the exit-event code: when we kill background
          // grandchildren above, `close` fires with `null` even though
          // the shell itself returned a real exit code.
          resolve({ exitCode: exited ? exitCode : code })
        })
      })
    },
  }
}
