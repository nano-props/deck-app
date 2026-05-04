import { formatSkillsForPrompt, loadSkillsFromDir, type Skill } from '@mariozechner/pi-coding-agent'
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
 * src/main/ai/tools.ts.
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
  return formatSkillsForPrompt(loadDeckSkills())
}

/**
 * Copy the "Minimal White" starter template (skills/create-deck/templates)
 * into `destDir`, substituting the supplied deck name into deck.json and
 * the <title> of index.html. destDir must already exist and be empty
 * (caller's responsibility).
 */
export async function createDeckFromTemplate(params: { destDir: string; name: string }): Promise<void> {
  const templateDir = path.join(skillsRoot(), 'create-deck', 'templates')
  const deckJsonSrc = path.join(templateDir, 'deck.json')
  const indexHtmlSrc = path.join(templateDir, 'index.html')

  if (!existsSync(deckJsonSrc) || !existsSync(indexHtmlSrc)) {
    throw new Error('Starter template files are missing from the bundled skills directory.')
  }

  const rawJson = await readFile(deckJsonSrc, 'utf8')
  const deckJson = rawJson.replace(/<deck-name>/g, params.name)
  const rawHtml = await readFile(indexHtmlSrc, 'utf8')
  const indexHtml = rawHtml.replace(/<deck-name>/g, params.name)

  await mkdir(params.destDir, { recursive: true })
  await writeFile(path.join(params.destDir, 'deck.json'), deckJson, 'utf8')
  await writeFile(path.join(params.destDir, 'index.html'), indexHtml, 'utf8')
}
