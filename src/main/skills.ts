import { formatSkillsForPrompt, loadSkillsFromDir, type Skill } from '@earendil-works/pi-coding-agent'
import { app } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Skill loader — delegates to pi-coding-agent's `loadSkillsFromDir`, which
 * implements the Anthropic Agent Skills spec:
 *
 *   skills/<name>/SKILL.md          ← frontmatter: name, description
 *   skills/<name>/reference/*.md    ← extra docs referenced by SKILL.md
 *   skills/<name>/templates/*       ← copyable starter files
 *
 * pi's loader writes an XML `<available_skills>` block with absolute
 * paths into the system prompt. The model reads SKILL.md via the
 * standard `read` tool — we allowlist `skillsRoot()` for reads in
 * src/main/ai/tools/sandbox.ts.
 *
 * Locations:
 *   Dev:      <repo>/skills
 *   Packaged: <Resources>/skills (see electron-builder.ts::extraResources)
 */

export function skillsRoot(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'skills')
  return path.join(import.meta.dirname, '..', '..', 'skills')
}

/** Module-cached skill index. Invalidated on app restart only. */
let cachedSkills: Skill[] | null = null
const EDITOR_EXCLUDED_SKILLS = new Set(['create-deck'])

function isEditorSkill(skill: Skill): boolean {
  return !EDITOR_EXCLUDED_SKILLS.has(skill.name)
}

/** Load every skill under `skillsRoot()`. Result is cached. */
export function loadDeckSkills(): Skill[] {
  if (cachedSkills) return cachedSkills
  const root = skillsRoot()
  if (!existsSync(root)) {
    cachedSkills = []
    return cachedSkills
  }
  const { skills, diagnostics } = loadSkillsFromDir({ dir: root, source: 'builtin' })
  // Skill validation errors (bad frontmatter, mismatched name, oversized
  // description, etc.) aren't fatal — pi still returns what it could
  // parse. Log them once at app startup so an authoring mistake isn't
  // silently absorbed.
  for (const d of diagnostics) {
    console.warn(`[skills] ${d.type}: ${d.message}${d.path ? ` (${d.path})` : ''}`)
  }
  cachedSkills = skills
  return cachedSkills
}

/** Render the skill index for the system prompt (empty string if none). */
export function formatDeckSkillsForPrompt(): string {
  return formatSkillsForPrompt(loadDeckSkills().filter(isEditorSkill))
}

/** Directories the Editor AI may read for skill content. */
export function editorSkillRoots(): string[] {
  return loadDeckSkills().filter(isEditorSkill).map((skill) => skill.baseDir)
}

/**
 * Copy the "Minimal White" starter template (skills/create-deck/templates)
 * into `destDir`, substituting the supplied deck name into deck.json and
 * the <title> of index.html. destDir must already exist and be empty
 * (caller's responsibility).
 *
 * The name is sourced from `path.basename(savedDir)` — i.e. whatever the
 * user typed in the Save dialog. macOS allows quotes/backslashes/even
 * newlines in folder names, and Windows allows angle-brackets-adjacent
 * characters too. We escape per output context so a name like
 *   `Foo "Bar"`
 * doesn't produce a deck.json that fails to parse, or a stray script
 * boundary inside the HTML <title>.
 */
export async function createDeckFromTemplate(params: { destDir: string; name: string }): Promise<void> {
  const templateDir = path.join(skillsRoot(), 'create-deck', 'templates')
  const deckJsonSrc = path.join(templateDir, 'deck.json')
  const indexHtmlSrc = path.join(templateDir, 'index.html')

  if (!existsSync(deckJsonSrc) || !existsSync(indexHtmlSrc)) {
    throw new Error('Starter template files are missing from the bundled skills directory.')
  }

  // Use callback-form replace so `$&`, `$1`, etc. in the user's deck
  // name aren't re-interpreted as backreferences. A name like `Foo$&Bar`
  // would otherwise re-emit the `<deck-name>` placeholder verbatim.
  const jsonValue = escapeForJsonString(params.name)
  const htmlValue = escapeForHtmlText(params.name)
  const rawJson = await readFile(deckJsonSrc, 'utf8')
  const deckJson = rawJson.replace(/<deck-name>/g, () => jsonValue)
  const rawHtml = await readFile(indexHtmlSrc, 'utf8')
  const indexHtml = rawHtml.replace(/<deck-name>/g, () => htmlValue)

  await mkdir(params.destDir, { recursive: true })
  await writeFile(path.join(params.destDir, 'deck.json'), deckJson, 'utf8')
  await writeFile(path.join(params.destDir, 'index.html'), indexHtml, 'utf8')
}

/**
 * Escape so the result can sit inside a JSON string literal. The template
 * has `"<deck-name>"` (placeholder already wrapped in quotes), so we want
 * the body of a JSON string — `JSON.stringify` adds the quotes itself,
 * we strip them.
 */
function escapeForJsonString(s: string): string {
  const stringified = JSON.stringify(s)
  return stringified.slice(1, -1)
}

/**
 * Escape for HTML text content. `<` is the only character that MUST be
 * escaped in text (otherwise it starts a tag). `&` we escape so a
 * pre-encoded entity in the source name doesn't get re-decoded. `>` is
 * not strictly required in text but a few legacy parsers misbehave
 * without it. Quotes are not escaped — they're fine inside text nodes.
 */
function escapeForHtmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
