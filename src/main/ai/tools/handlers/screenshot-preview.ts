import { type AgentTool } from '@earendil-works/pi-agent-core'
import { type Static, Type } from '@earendil-works/pi-ai'
import { nativeImage } from 'electron'
import type { DeckToolsContext } from '../context.ts'

// 1568 mirrors Anthropic's recommended long-edge for screenshots — large
// enough to read body text in slides, small enough that token cost stays
// reasonable. PNG keeps text crisp; JPEG would smear small fonts.
const SCREENSHOT_MAX_LONG_EDGE = 1568

const screenshotPreviewSchema = Type.Object({}, { additionalProperties: false })
type ScreenshotPreviewParams = Static<typeof screenshotPreviewSchema>

export function screenshotPreviewTool(
  capturePreview: NonNullable<DeckToolsContext['capturePreview']>,
): AgentTool<typeof screenshotPreviewSchema> {
  return {
    name: 'screenshot_preview',
    label: 'Screenshot preview',
    description:
      `Capture the live deck preview as a PNG and attach it to the conversation so you ` +
      `can see what the user sees. Use after structural edits to verify layout, or when ` +
      `the user asks about something visible. The preview hot-reloads after each edit; ` +
      `if the screenshot still shows the pre-edit state, do another small action (e.g. ` +
      `read the file you just wrote) and screenshot again — that gives the iframe a ` +
      `chance to repaint.`,
    parameters: screenshotPreviewSchema,
    execute: async (_id, _params: ScreenshotPreviewParams) => {
      const captured = await capturePreview()
      if (!captured) {
        throw new Error(
          'Preview is not available right now (Play-only mode, no deck loaded, or the ' +
            'preview view was destroyed).',
        )
      }
      // Electron returns a "data:image/png;base64,..." URL. Strip the
      // prefix so we hand the agent raw base64, matching ImageContent's
      // contract (data is bytes, not a data URL).
      const m = /^data:(image\/[a-z+.-]+);base64,(.*)$/i.exec(captured.dataUrl)
      if (!m) throw new Error('Preview snapshot returned an unexpected data URL shape.')
      let mimeType = m[1]
      let base64 = m[2]

      // Resize down so we don't ship a 4K Retina capture into every
      // turn. nativeImage is already RGBA in memory, so we go through
      // it for the resize and re-encode as PNG.
      try {
        const original = nativeImage.createFromDataURL(captured.dataUrl)
        const size = original.getSize()
        const longEdge = Math.max(size.width, size.height)
        if (longEdge > SCREENSHOT_MAX_LONG_EDGE) {
          const scale = SCREENSHOT_MAX_LONG_EDGE / longEdge
          const resized = original.resize({
            width: Math.round(size.width * scale),
            height: Math.round(size.height * scale),
            quality: 'good',
          })
          base64 = resized.toPNG().toString('base64')
          mimeType = 'image/png'
        }
      } catch {
        // Resize is best-effort; fall through with the raw capture if
        // nativeImage rejects (corrupt PNG, etc.).
      }

      return {
        content: [{ type: 'image', data: base64, mimeType }],
        details: { mimeType, bytes: Math.floor((base64.length * 3) / 4) },
      }
    },
  }
}
