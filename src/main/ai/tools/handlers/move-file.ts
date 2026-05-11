import { type AgentTool } from '@earendil-works/pi-agent-core'
import { withFileMutationQueue } from '@earendil-works/pi-coding-agent'
import { type Static, Type } from '@earendil-works/pi-ai'
import { existsSync, statSync } from 'node:fs'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveSandboxPath } from '../sandbox.ts'
import { RESERVED_DECK_FILES } from '../reserved.ts'
import type { DeckToolsContext } from '../context.ts'

const moveFileSchema = Type.Object(
  {
    from: Type.String({ description: 'Existing path, relative to the Deck Source root.' }),
    to: Type.String({
      description:
        'Destination path, relative to the Deck Source root. Parent directories are ' +
        'created as needed. Overwriting an existing file is refused unless overwrite=true.',
    }),
    overwrite: Type.Optional(
      Type.Boolean({
        description: 'Allow replacing an existing file at the destination (default: false).',
      }),
    ),
  },
  { additionalProperties: false },
)
type MoveFileParams = Static<typeof moveFileSchema>

export function moveFileTool(ctx: DeckToolsContext): AgentTool<typeof moveFileSchema> {
  return {
    name: 'move_file',
    label: 'Move file',
    description:
      'Rename or move a single file inside the Deck Source. Both endpoints must stay ' +
      'within the Deck Source. Refuses to clobber or relocate the reserved files ' +
      '(deck.json, index.html). Cross-device renames fall back to copy+delete.',
    parameters: moveFileSchema,
    execute: async (_id, params: MoveFileParams) => {
      const fromAbs = path.resolve(ctx.rootDir, params.from)
      const toAbs = path.resolve(ctx.rootDir, params.to)
      const fromChecked = await resolveSandboxPath(fromAbs, ctx.rootDir, /* writable */ true)
      const toChecked = await resolveSandboxPath(toAbs, ctx.rootDir, /* writable */ true)
      const fromRel = fromChecked.relPath
      const toRel = toChecked.relPath
      if (fromRel === null || toRel === null) {
        throw new Error('Both `from` and `to` must be inside the Deck Source.')
      }
      if (fromRel === '' || toRel === '') {
        throw new Error('Refusing to move the Deck Source root.')
      }
      if (fromRel === toRel) {
        // No-op rename — return early so we don't churn the file watcher.
        return {
          content: [{ type: 'text', text: `move_file no-op: ${fromRel} == ${toRel}` }],
          details: { from: fromRel, to: toRel, noop: true },
        }
      }
      if (RESERVED_DECK_FILES.has(fromRel)) {
        throw new Error(`Refusing to move reserved file ${fromRel}; edit it in place.`)
      }
      if (RESERVED_DECK_FILES.has(toRel)) {
        throw new Error(`Refusing to overwrite reserved file ${toRel} via move_file; use write/edit instead.`)
      }

      let fromStat: import('node:fs').Stats
      try {
        fromStat = await stat(fromAbs)
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code === 'ENOENT') throw new Error(`Source not found: ${fromRel}`)
        throw e
      }
      if (fromStat.isDirectory()) {
        throw new Error(`move_file targets a directory: ${fromRel}. Directory moves are not supported.`)
      }

      if (existsSync(toAbs)) {
        const toStat = statSync(toAbs)
        if (toStat.isDirectory()) {
          throw new Error(`Destination is a directory: ${toRel}. Pass a file path.`)
        }
        if (!params.overwrite) {
          throw new Error(`Destination already exists: ${toRel}. Pass overwrite=true to replace.`)
        }
      }

      await mkdir(path.dirname(toAbs), { recursive: true })
      // Two file paths share one move — lock both (alphabetically) so a
      // concurrent edit on either side serializes against us.
      const [a, b] = fromAbs < toAbs ? [fromAbs, toAbs] : [toAbs, fromAbs]
      await withFileMutationQueue(a, async () => {
        await withFileMutationQueue(b, async () => {
          try {
            await rename(fromAbs, toAbs)
          } catch (e) {
            // EXDEV: source/dest live on different filesystems (rare but
            // possible if rootDir is a bind-mount or a tmpdir on another
            // device). Fall back to copy + unlink so move_file works
            // anywhere. Anything else is a real error.
            const code = (e as NodeJS.ErrnoException).code
            if (code !== 'EXDEV') throw e
            const buf = await readFile(fromAbs)
            await writeFile(toAbs, buf)
            await unlink(fromAbs)
          }
        })
      })
      // Notify both sides so the watcher / preview reload picks up
      // disappearance and appearance.
      ctx.onFileChange?.(fromRel)
      ctx.onFileChange?.(toRel)
      return {
        content: [{ type: 'text', text: `Moved ${fromRel} → ${toRel}` }],
        details: { from: fromRel, to: toRel },
      }
    },
  }
}
