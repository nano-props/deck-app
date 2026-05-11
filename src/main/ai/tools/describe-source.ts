/**
 * System-prompt helper. Lives in the tools tree because it shares the
 * untrusted-input sanitization concern with the tool surface (deck.json
 * fields and filenames are author-controlled and feed into the LLM
 * prompt), but it is NOT an AgentTool — it's invoked once at session
 * start by `session/system-prompt.ts` to render an `Entries (two levels
 * deep)` block.
 *
 * Sanitization is the load-bearing primitive here: a malicious deck
 * could otherwise inject pseudo-instructions via filenames containing
 * newlines or via deck.json fields that close XML-shaped fences.
 * `sanitizeFileNameForPrompt` and `sanitizeManifestField` both strip
 * control chars, collapse whitespace, and truncate.
 */
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

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
  return name
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}
