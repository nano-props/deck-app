import { type AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveSandboxPath } from '../sandbox.ts'
import { checkDeckJsonShape } from '../reserved.ts'
import type { DeckToolsContext } from '../context.ts'

/**
 * Pull all `src` / `href` values out of an HTML string. Intentionally
 * regex-based (not a full HTML parser): the rendered page itself is
 * what runs in production, and we just want a low-cost "did the model
 * reference a path that doesn't exist". Misses fancy cases (CSS
 * `url(...)`, dynamic `import()`, `<source srcset>`); good enough as a
 * smoke test, and the model can still ask `read` for a deeper look.
 *
 * HTML comments are stripped before scanning so a commented-out
 * `<img src="old.png">` doesn't produce a false-positive "missing
 * referenced file" — the browser ignores those, and so should we.
 */
function extractHtmlRefs(html: string): string[] {
  const stripped = html.replace(/<!--[\s\S]*?-->/g, '')
  const out: string[] = []
  const re = /\b(?:src|href)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi
  for (const m of stripped.matchAll(re)) {
    const v = m[2] ?? m[3] ?? m[4]
    if (v) out.push(v)
  }
  return out
}

function isExternalOrInline(ref: string): boolean {
  // External or non-file refs we don't try to validate.
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return true // http:, https:, data:, mailto:, etc.
  if (ref.startsWith('//')) return true // protocol-relative
  if (ref.startsWith('#')) return true // fragment
  return false
}

interface DeckCheckResult {
  issues: string[]
  ok: string[]
  manifest: { name?: unknown } | null
}

async function checkDeckJson(rootDir: string): Promise<DeckCheckResult> {
  const manifestAbs = path.join(rootDir, 'deck.json')
  if (!existsSync(manifestAbs)) {
    return { issues: ['deck.json: missing at the Deck Source root'], ok: [], manifest: null }
  }
  let raw: string
  try {
    raw = await readFile(manifestAbs, 'utf-8')
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    return { issues: [`deck.json: unreadable (${reason})`], ok: [], manifest: null }
  }
  let parsed: { name?: unknown }
  try {
    parsed = JSON.parse(raw) as { name?: unknown }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    return { issues: [`deck.json: invalid JSON (${reason})`], ok: [], manifest: null }
  }
  const shapeIssues = checkDeckJsonShape(parsed).map((s) => `deck.json: ${s}`)
  const ok = shapeIssues.length === 0 && typeof parsed.name === 'string' ? [`deck.json: name = ${parsed.name}`] : []
  return { issues: shapeIssues, ok, manifest: parsed }
}

async function checkIndexHtml(rootDir: string): Promise<Pick<DeckCheckResult, 'issues' | 'ok'>> {
  const indexAbs = path.join(rootDir, 'index.html')
  if (!existsSync(indexAbs)) {
    return { issues: ['index.html: missing at the Deck Source root'], ok: [] }
  }
  let html: string
  try {
    html = await readFile(indexAbs, 'utf-8')
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    return { issues: [`index.html: unreadable (${reason})`], ok: [] }
  }
  const issues: string[] = []
  const checked = new Set<string>()
  let missingCount = 0
  for (const ref of extractHtmlRefs(html)) {
    if (isExternalOrInline(ref)) continue
    // Strip query / fragment — they're not part of the file path.
    const cleaned = ref.replace(/[?#].*$/, '')
    if (!cleaned || checked.has(cleaned)) continue
    checked.add(cleaned)
    // Anchor refs at the Deck Source root (this is what the local
    // server does — the deck is served with rootDir as the doc root).
    const refAbs = path.resolve(rootDir, cleaned.replace(/^\/+/, ''))
    // Even though refs are author-controlled, run the sandbox check so
    // a stray `../foo` is reported as escaping rather than as a Deck file.
    try {
      await resolveSandboxPath(refAbs, rootDir, /* writable */ false)
    } catch {
      issues.push(`index.html: reference escapes the Deck Source: ${ref}`)
      missingCount++
      continue
    }
    if (!existsSync(refAbs)) {
      issues.push(`index.html: missing referenced file: ${cleaned}`)
      missingCount++
    }
  }
  return {
    issues,
    ok: [`index.html: scanned ${checked.size} local refs, ${missingCount} missing`],
  }
}

function formatDeckReport(result: DeckCheckResult): string {
  const summary = result.issues.length === 0 ? 'OK' : `${result.issues.length} issue(s)`
  return [
    `Deck validation: ${summary}`,
    ...result.issues.map((s) => `  ✗ ${s}`),
    '',
    'Checks:',
    ...result.ok.map((s) => `  • ${s}`),
  ].join('\n')
}

const validateDeckSchema = Type.Object({}, { additionalProperties: false })

export function validateDeckTool(ctx: DeckToolsContext): AgentTool<typeof validateDeckSchema> {
  return {
    name: 'validate_deck',
    label: 'Validate deck',
    description:
      'Sanity-check the Deck Source: parses deck.json and scans index.html for ' +
      'src/href references that point to missing files. Read-only — does not modify ' +
      'anything. Use after structural changes to confirm the deck is still loadable.',
    parameters: validateDeckSchema,
    execute: async () => {
      const manifest = await checkDeckJson(ctx.rootDir)
      const html = await checkIndexHtml(ctx.rootDir)
      const result: DeckCheckResult = {
        issues: [...manifest.issues, ...html.issues],
        ok: [...manifest.ok, ...html.ok],
        manifest: manifest.manifest,
      }
      return {
        content: [{ type: 'text', text: formatDeckReport(result) }],
        details: result,
      }
    },
  }
}
