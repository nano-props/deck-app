/**
 * Tool surface for the Edit sub-view's Agent.
 *
 * We use pi-coding-agent's tool factories (read / write / edit / ls /
 * grep / find) rather than hand-rolling them — they're the same tools
 * the `pi` CLI ships, so the prompt behavior and tool-calling ergonomics
 * are well-exercised. Every factory takes an `operations` object; we
 * plug in a *sandboxed* implementation that rejects any path outside the
 * Deck Source (plus a read-only allowlist for Editor-appropriate skills,
 * so the model can read listed SKILL.md files by their absolute paths).
 *
 * One Deck-specific tool: `add_asset`. pi has no base64 binary inject
 * tool, and we need one because renderer attachment chips arrive over
 * IPC as bytes. Writing via `write_file` would require the model to
 * base64-round-trip through its own transcript — wasteful.
 *
 * grep / find: pi's defaults shell out to `rg` / `fd` and will silently
 * download those binaries from GitHub on first use. We override that
 * by providing custom `operations` — find runs through a Node glob
 * implementation, grep runs a Node-native scanner. No external binaries,
 * no surprise network I/O.
 *
 * Notably absent:
 *   - `bash` — letting an LLM run arbitrary shell commands is an
 *     unbounded capability; the read/write/edit/ls/grep/find surface
 *     covers everything Deck authoring actually needs. Removed in
 *     favor of fine-grained tools (see git history for the prior
 *     sandbox-exec wrapper).
 *   - `list_skills` / `read_skill` — pi's convention is that the system
 *     prompt lists skills with absolute paths, and the model reads them
 *     with the standard `read` tool. We allowlist only Editor-visible
 *     skill roots below.
 */
import {
  createEditTool,
  createFindTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from '@earendil-works/pi-coding-agent'
import { type AgentTool } from '@earendil-works/pi-agent-core'
import { createDeckGrepTool } from '#/main/ai/grep-tool.ts'
import type { DeckToolsContext } from './context.ts'
import { editOps, findOps, grepOps, lsOps, readOps, writeOps } from './ops.ts'
import { addAssetTool } from './handlers/add-asset.ts'
import { deleteFileTool } from './handlers/delete-file.ts'
import { moveFileTool } from './handlers/move-file.ts'
import { validateDeckTool } from './handlers/validate-deck.ts'
import { fetchUrlTool } from './handlers/fetch-url.ts'
import { readUrlTool } from './handlers/read-url.ts'
import { screenshotPreviewTool } from './handlers/screenshot-preview.ts'

export type { DeckToolsContext } from './context.ts'
export { describeDeckSource } from './describe-source.ts'

export function createDeckTools(ctx: DeckToolsContext): AgentTool<any>[] {
  const { rootDir } = ctx
  // pi's factories accept relative paths from the model and resolve them
  // against `cwd`. rootDir is an absolute path (see deck-loader.ts), so
  // passing it directly works.
  const tools: AgentTool<any>[] = [
    createReadTool(rootDir, { operations: readOps(rootDir) }),
    createWriteTool(rootDir, { operations: writeOps(ctx) }),
    createEditTool(rootDir, { operations: editOps(ctx) }),
    createLsTool(rootDir, { operations: lsOps(rootDir) }),
    createDeckGrepTool({ cwd: rootDir, operations: grepOps(rootDir) }),
    createFindTool(rootDir, { operations: findOps(rootDir) }),
    addAssetTool(ctx),
    deleteFileTool(ctx),
    moveFileTool(ctx),
    validateDeckTool(ctx),
    fetchUrlTool(ctx),
    readUrlTool(),
  ]
  // Only expose screenshot_preview when a capture function is wired —
  // otherwise the model would call a tool that always errors.
  if (ctx.capturePreview) tools.push(screenshotPreviewTool(ctx.capturePreview))
  return tools
}
