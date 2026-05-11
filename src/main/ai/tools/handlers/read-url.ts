import { type AgentTool } from '@earendil-works/pi-agent-core'
import { type Static, Type } from '@earendil-works/pi-ai'
import { fetchWithCap } from '../http.ts'

const READ_URL_MAX_BYTES = 2 * 1024 * 1024 // 2 MB — large enough for docs/specs, small enough not to bloat context
const READ_URL_TEXT_TYPES = /^(?:text\/|application\/(?:json|xml|javascript|x-yaml|yaml))/i

const readUrlSchema = Type.Object(
  {
    url: Type.String({ description: 'http(s) URL to read.' }),
  },
  { additionalProperties: false },
)
type ReadUrlParams = Static<typeof readUrlSchema>

export function readUrlTool(): AgentTool<typeof readUrlSchema> {
  return {
    name: 'read_url',
    label: 'Read URL',
    description:
      `Read a remote http(s) text resource (HTML, Markdown, JSON, plain text) into the ` +
      `chat context without writing it to disk. Use for docs, specs, READMEs, npm package ` +
      `pages — anything you want to consult before editing. Capped at ` +
      `${READ_URL_MAX_BYTES / (1024 * 1024)} MB and text content types only. For binary ` +
      `assets use fetch_url, which writes to the Deck Source.`,
    parameters: readUrlSchema,
    execute: async (_id, params: ReadUrlParams, signal) => {
      let parsed: URL
      try {
        parsed = new URL(params.url)
      } catch {
        throw new Error(`Invalid URL: ${params.url}`)
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`read_url only supports http(s); got ${parsed.protocol}`)
      }

      const { buf, total, contentType } = await fetchWithCap({
        url: parsed,
        maxBytes: READ_URL_MAX_BYTES,
        toolName: 'read_url',
        signal,
        textContentTypeOnly: READ_URL_TEXT_TYPES,
      })

      const text = buf.toString('utf-8')
      return {
        content: [{ type: 'text', text }],
        details: { url: parsed.toString(), bytes: total, contentType },
      }
    },
  }
}
