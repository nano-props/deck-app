import { type AgentTool } from '@earendil-works/pi-agent-core'
import { withFileMutationQueue } from '@earendil-works/pi-coding-agent'
import { type Static, Type } from '@earendil-works/pi-ai'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveSandboxPath } from '../sandbox.ts'
import { RESERVED_DECK_FILES } from '../reserved.ts'
import { fetchWithCap } from '../http.ts'
import type { DeckToolsContext } from '../context.ts'

const FETCH_URL_MAX_BYTES = 25 * 1024 * 1024 // 25 MB — enough for most images / fonts / short videos

const fetchUrlSchema = Type.Object(
  {
    url: Type.String({ description: 'http(s) URL to download.' }),
    path: Type.String({
      description:
        'Destination relative path inside the Deck Source. If it contains no "/" the ' +
        'file lands under "assets/". The filename must have an extension.',
    }),
    overwrite: Type.Optional(Type.Boolean({ description: 'Allow replacing an existing file (default: false).' })),
  },
  { additionalProperties: false },
)
type FetchUrlParams = Static<typeof fetchUrlSchema>

export function fetchUrlTool(ctx: DeckToolsContext): AgentTool<typeof fetchUrlSchema> {
  return {
    name: 'fetch_url',
    label: 'Fetch URL',
    description:
      `Download a remote file (http/https only) into the Deck Source. Default ` +
      `location is assets/<name>; pass a full relative path to override. Caps at ` +
      `${FETCH_URL_MAX_BYTES / (1024 * 1024)} MB. Refuses non-http(s) schemes and the ` +
      `reserved files (deck.json, index.html).`,
    parameters: fetchUrlSchema,
    execute: async (_id, params: FetchUrlParams, signal) => {
      let parsed: URL
      try {
        parsed = new URL(params.url)
      } catch {
        throw new Error(`Invalid URL: ${params.url}`)
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`fetch_url only supports http(s); got ${parsed.protocol}`)
      }

      // Path policy mirrors add_asset.
      if (path.isAbsolute(params.path) || params.path.split(/[/\\]/).some((seg) => seg === '..')) {
        throw new Error(`fetch_url path must be relative and within the Deck (no "..").`)
      }
      const hasDir = params.path.includes('/')
      const rel = hasDir ? params.path : path.posix.join('assets', params.path)
      if (!path.extname(rel)) {
        throw new Error(`Destination filename needs an extension: ${params.path}`)
      }
      const relPosix = rel.split(path.sep).join('/')
      if (RESERVED_DECK_FILES.has(relPosix)) {
        throw new Error(`Refusing to overwrite ${relPosix} via fetch_url; use write/edit instead.`)
      }
      const abs = path.resolve(ctx.rootDir, rel)
      await resolveSandboxPath(abs, ctx.rootDir, /* writable */ true)
      if (existsSync(abs) && !params.overwrite) {
        throw new Error(`Destination already exists: ${relPosix}. Pass overwrite=true to replace.`)
      }

      const { buf } = await fetchWithCap({
        url: parsed,
        maxBytes: FETCH_URL_MAX_BYTES,
        toolName: 'fetch_url',
        signal,
      })

      await mkdir(path.dirname(abs), { recursive: true })
      await withFileMutationQueue(abs, async () => {
        await writeFile(abs, buf)
      })
      ctx.onFileChange?.(relPosix)
      return {
        content: [
          {
            type: 'text',
            text: `Fetched ${parsed.toString()} -> ${relPosix} (${buf.length} bytes)`,
          },
        ],
        details: { url: parsed.toString(), path: relPosix, bytes: buf.length },
      }
    },
  }
}
