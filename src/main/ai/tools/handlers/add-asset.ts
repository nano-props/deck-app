import { type AgentTool } from '@earendil-works/pi-agent-core'
import { withFileMutationQueue } from '@earendil-works/pi-coding-agent'
import { type Static, Type } from '@earendil-works/pi-ai'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveSandboxPath } from '../sandbox.ts'
import { RESERVED_DECK_FILES } from '../reserved.ts'
import type { DeckToolsContext } from '../context.ts'

const addAssetSchema = Type.Object(
  {
    path: Type.String({
      description:
        'Relative path from the Deck Source root. If it contains no "/" ' +
        'the asset lands under "assets/". The filename must have an extension.',
    }),
    base64: Type.String({ description: 'File bytes, base64-encoded.' }),
  },
  { additionalProperties: false },
)
type AddAssetParams = Static<typeof addAssetSchema>

export function addAssetTool(ctx: DeckToolsContext): AgentTool<typeof addAssetSchema> {
  return {
    name: 'add_asset',
    label: 'Add asset',
    description:
      'Write a binary asset (image / font / audio / video) into the Deck Source. ' +
      'Provide the file bytes as base64. Default location is assets/<name>; ' +
      'pass a full relative path to override. Existing files are overwritten.',
    parameters: addAssetSchema,
    execute: async (_id, params: AddAssetParams) => {
      // Reject absolute paths and any segment that climbs out — `..` would
      // pass the sandbox if the segments cancel out (`a/../deck.json`),
      // landing inside root but on a non-asset file. The tool is named
      // `add_asset`; clobbering deck.json / index.html via this path is a
      // contract violation regardless of being technically inside root.
      if (path.isAbsolute(params.path) || params.path.split(/[/\\]/).some((seg) => seg === '..')) {
        throw new Error(`add_asset path must be relative and within the Deck (no "..").`)
      }
      const hasDir = params.path.includes('/')
      const rel = hasDir ? params.path : path.posix.join('assets', params.path)
      if (!path.extname(rel)) {
        throw new Error(`Asset filename needs an extension: ${params.path}`)
      }
      // Reserved authoring files — agent uses `write` / `edit` for those.
      const relPosix = rel.split(path.sep).join('/')
      if (RESERVED_DECK_FILES.has(relPosix)) {
        throw new Error(`Refusing to overwrite ${relPosix} via add_asset; use write/edit instead.`)
      }
      const abs = path.resolve(ctx.rootDir, rel)
      await resolveSandboxPath(abs, ctx.rootDir, /* writable */ true)
      // Tolerate a leading `data:<mime>;base64,` prefix — models
      // occasionally hand the full data URL straight from a clipboard.
      // Buffer.from silently strips invalid characters, so we also
      // require the result to be non-empty for a non-empty input.
      const stripped = params.base64.replace(/^data:[^;,]*;base64,/i, '').trim()
      if (!stripped) {
        throw new Error('add_asset: empty base64 payload.')
      }
      const buf = Buffer.from(stripped, 'base64')
      if (buf.length === 0) {
        throw new Error('add_asset: base64 decode produced 0 bytes — likely malformed input.')
      }
      await mkdir(path.dirname(abs), { recursive: true })
      await withFileMutationQueue(abs, async () => {
        await writeFile(abs, buf)
      })
      ctx.onFileChange?.(rel)
      return {
        content: [{ type: 'text', text: `Added ${rel} (${buf.length} bytes)` }],
        details: { path: rel, bytes: buf.length },
      }
    },
  }
}
