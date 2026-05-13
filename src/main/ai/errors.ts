/**
 * Typed errors for AI session lifecycle failures.
 *
 * Why this exists: before, the manager's `localizeFatal` was matching
 * raw `err.message` strings — `if (msg.includes('Claude Code CLI not
 * found'))` to pick the right i18n key. That was fragile in two ways:
 *   1. detect.ts changing its message text would silently break the
 *      i18n match, falling back to showing the raw English string.
 *   2. There was no way to add a new error category without touching
 *      both the throw site (a string) and the localizer (another
 *      string). Two places to keep in sync, only one of which fails
 *      loudly.
 *
 * `DeckErrorCode` is the union of recognized failure modes. Throw
 * sites construct `new DeckError(code, fallbackMessage)`; the
 * localizer switches on `code` for an i18n-resolved message and falls
 * back to the throw-site `message` for unknown / generic errors.
 *
 * The fallback message is what shows up in main-process logs and in
 * unrecognized-code paths, so keep it informative — bug reports rely
 * on it more than on the i18n string.
 */

/** Known failure categories. Add to this union (and the localizer)
 *  when surfacing a new failure mode the renderer should i18n. */
export type DeckErrorCode =
  /** Claude Code CLI binary couldn't be located in PATH or any of the
   *  common install dirs we sweep. User must install it or pick a
   *  different provider. */
  | 'CLI_NOT_FOUND'

export class DeckError extends Error {
  readonly code: DeckErrorCode
  constructor(code: DeckErrorCode, message: string) {
    super(message)
    this.name = 'DeckError'
    this.code = code
  }
}

/** Type-guard. `instanceof DeckError` works in main-process code, but
 *  this helper is preferred when you've shaped the value as `unknown`
 *  (typical inside a catch). */
export function isDeckError(err: unknown): err is DeckError {
  return err instanceof DeckError
}
