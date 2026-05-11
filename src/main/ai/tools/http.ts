import { net } from 'electron'

/**
 * Shared HTTP-with-cap fetcher used by `fetch_url` (writes binary asset
 * to disk) and `read_url` (returns text into chat). We use Electron's
 * `net.fetch` rather than global fetch because it routes through
 * Electron's session (proxy / cookies the user expects), and it's the
 * documented main-process HTTP client.
 *
 * Error message prefixes are parameterized by `toolName` to keep
 * tool-level error strings byte-equivalent to the pre-extraction code.
 */
export async function fetchWithCap(args: {
  url: URL
  maxBytes: number
  toolName: 'fetch_url' | 'read_url'
  signal?: AbortSignal
  textContentTypeOnly?: RegExp
}): Promise<{ buf: Buffer; total: number; contentType: string }> {
  const { url, maxBytes, toolName, signal, textContentTypeOnly } = args

  const res = await net.fetch(url.toString(), { redirect: 'follow', signal })
  if (!res.ok) {
    throw new Error(`${toolName} ${url.toString()} -> HTTP ${res.status} ${res.statusText}`)
  }

  const contentType = res.headers.get('content-type') || ''
  if (textContentTypeOnly && contentType && !textContentTypeOnly.test(contentType)) {
    throw new Error(
      `read_url expects text content; got ${contentType}. ` + `Use fetch_url to download binaries to the Deck Source.`,
    )
  }

  // Cheap pre-check via Content-Length, then a hard cap during read
  // (since servers can lie or omit the header). The "Remote file" /
  // "Remote resource" wording is preserved per tool below.
  const lenHeader = res.headers.get('content-length')
  if (lenHeader && Number(lenHeader) > maxBytes) {
    const noun = toolName === 'fetch_url' ? 'Remote file' : 'Remote resource'
    throw new Error(`${noun} ${lenHeader} bytes exceeds ${maxBytes} byte cap.`)
  }

  const body = res.body
  if (!body) {
    throw new Error(`${toolName} got an empty response body.`)
  }

  const chunks: Uint8Array[] = []
  let total = 0
  const reader = body.getReader()
  while (true) {
    if (signal?.aborted) {
      try {
        await reader.cancel()
      } catch {
        // already closed
      }
      throw new Error(`${toolName} aborted.`)
    }
    const { value, done } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      // Best-effort cancel so the connection doesn't keep streaming.
      try {
        await reader.cancel()
      } catch {
        // already closed
      }
      const noun = toolName === 'fetch_url' ? 'Remote file' : 'Remote resource'
      throw new Error(`${noun} exceeds ${maxBytes} byte cap (read ${total} bytes).`)
    }
    chunks.push(value)
  }

  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)))
  return { buf, total, contentType }
}
