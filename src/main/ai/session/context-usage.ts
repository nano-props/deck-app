import type { Usage } from '@earendil-works/pi-ai'
import {
  calculateContextTokens,
  estimateTokens,
  getLastAssistantUsage,
  type SessionEntry,
  type SessionMessageEntry,
} from '@earendil-works/pi-coding-agent'

/**
 * Estimate current context tokens. Prefers the authoritative `usage`
 * field from the last assistant message (real provider numbers),
 * falling back to pi's `estimateTokens` heuristic for messages with no
 * usage attached.
 *
 * Mirrors pi's private `estimateContextTokens` — reimplemented here
 * from its public building blocks (`getLastAssistantUsage`,
 * `calculateContextTokens`, `estimateTokens`) so we don't depend on a
 * non-exported helper.
 *
 * Caveat: this walks message entries only, skipping compaction
 * entries. Before pi wires up real compaction that's the same as pi's
 * own estimate; after, our number will understate by the summary's
 * token cost (pi would turn the summary into a user message via
 * convertToLlm and count it). Fine as an indicator, but don't treat it
 * as byte-accurate once compaction is live.
 */
export function contextTokensFromBranch(branch: SessionEntry[]): number {
  const usage: Usage | undefined = getLastAssistantUsage(branch)
  if (!usage) {
    let total = 0
    for (const entry of branch) {
      if (entry.type !== 'message') continue
      total += estimateTokens((entry as SessionMessageEntry).message)
    }
    return total
  }
  const base = calculateContextTokens(usage)
  // Messages after the last usage-bearing assistant message aren't
  // covered by provider numbers — estimate them. Walk back until we hit
  // the assistant message that produced `usage`, then stop.
  let trailing = 0
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]
    if (entry.type !== 'message') continue
    const msg = (entry as SessionMessageEntry).message
    if (msg.role === 'assistant' && (msg as { usage?: Usage }).usage) break
    trailing += estimateTokens(msg)
  }
  return base + trailing
}
