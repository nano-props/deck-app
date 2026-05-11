/**
 * Reserved-path policy + manifest schema.
 *
 * Two related concerns share this module because both protect the
 * subset of files the deck-load path treats as required (`deck.json`,
 * `index.html`):
 *
 *   - `RESERVED_DECK_FILES` is consulted by handlers (`add_asset`,
 *     `delete_file`, `move_file`, `fetch_url`) to refuse structural
 *     changes that would clobber or relocate these. The agent edits
 *     them in place via `write` / `edit`.
 *   - `checkDeckJsonShape` + `validateReservedFileContent` validate
 *     content the agent is about to write to those reserved files.
 *     `writeOps` / `editOps` invoke the validator pre-flush so a
 *     malformed manifest never lands on disk.
 *
 * Pure module — no state, no I/O. Sandbox containment is handled
 * upstream in sandbox.ts; this layer is just policy/schema.
 */

/**
 * Files the agent must reach via `write` / `edit`, not via the
 * convenience tools (`add_asset` for binaries, `delete_file` /
 * `move_file` for structural changes). Clobbering or losing these by
 * accident breaks the deck — the load path expects them at fixed names.
 *
 * Kept module-level so every tool that mutates the tree applies the
 * same list. Compared as POSIX paths relative to rootDir.
 */
export const RESERVED_DECK_FILES: ReadonlySet<string> = new Set(['deck.json', 'index.html'])

/**
 * Single source of truth for deck.json's expected shape. Returns a
 * (possibly empty) list of human-readable problems. Shared by the
 * write-time validator (which throws on any issue) and the
 * `validate_deck` read-time tool (which collects them into a report) —
 * extending the schema (e.g. requiring `version`) only needs one edit.
 */
export function checkDeckJsonShape(parsed: unknown): string[] {
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
export function validateReservedFileContent(rel: string | null, content: string): void {
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
