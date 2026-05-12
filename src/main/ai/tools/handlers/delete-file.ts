import { type AgentTool } from '@earendil-works/pi-agent-core'
import { withFileMutationQueue } from '@earendil-works/pi-coding-agent'
import { type Static, Type } from '@earendil-works/pi-ai'
import { stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { resolveSandboxPath } from '../sandbox.ts'
import { RESERVED_DECK_FILES } from '../reserved.ts'
import type { DeckToolsContext } from '../context.ts'

const deleteFileSchema = Type.Object(
  {
    path: Type.String({
      description:
        'Path of the file to delete. Relative paths resolve against the Deck Source root. ' +
        'Directories are not supported — use repeated calls if needed.',
    }),
  },
  { additionalProperties: false },
)
type DeleteFileParams = Static<typeof deleteFileSchema>

export function deleteFileTool(ctx: DeckToolsContext): AgentTool<typeof deleteFileSchema> {
  return {
    name: 'delete_file',
    label: 'Delete file',
    description:
      'Permanently delete a single file inside the Deck Source. Refuses directories ' +
      'and the reserved files (deck.json, index.html) — those are edited, not deleted. ' +
      'Use this rather than emulating delete via write_file with empty content.',
    parameters: deleteFileSchema,
    execute: async (_id, params: DeleteFileParams) => {
      const abs = path.resolve(ctx.rootDir, params.path)
      const checked = await resolveSandboxPath(abs, ctx.rootDir, /* writable */ true)
      const relPosix = checked.relPath
      if (relPosix === null) {
        // resolveSandboxPath should already have thrown, but defense in depth.
        throw new Error(`Path is outside the deck root: ${params.path}`)
      }
      if (relPosix === '') {
        throw new Error('Refusing to delete the Deck Source root.')
      }
      if (RESERVED_DECK_FILES.has(relPosix)) {
        throw new Error(`Refusing to delete ${relPosix}; use write/edit to modify it instead.`)
      }
      let st: import('node:fs').Stats
      try {
        st = await stat(abs)
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code === 'ENOENT') throw new Error(`File not found: ${relPosix}`)
        throw e
      }
      if (st.isDirectory()) {
        throw new Error(`delete_file targets a directory: ${relPosix}. Directory removal is not supported.`)
      }
      await withFileMutationQueue(abs, async () => {
        await unlink(abs)
      })
      ctx.onFileChange?.(relPosix)
      return {
        content: [{ type: 'text', text: `Deleted ${relPosix}` }],
        details: { path: relPosix },
      }
    },
  }
}
