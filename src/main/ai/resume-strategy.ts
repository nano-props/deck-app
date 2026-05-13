/**
 * Pure decision logic for "can this session record be resumed across a
 * deck reopen?". Lives in its own module (no electron / fs deps) so
 * unit tests can cover the (provider × deck.kind) matrix without
 * spinning up the app.
 *
 * The unit of truth: Claude CLI hashes cwd into its transcript path
 * (`~/.claude/projects/<cwd-hash>/<uuid>.jsonl`), but Pack/preview
 * decks extract to a fresh tmpdir each open — same `--session-id` uuid
 * would resolve to a different hash on every run, so the resume hint
 * is unreachable. Pi-agent backends store transcripts under our
 * userData dir keyed off `chatKey`, which IS stable across opens, so
 * they're unaffected.
 *
 * Older app versions persisted Pack+CLI rows with non-null
 * `providerSessionId`; those are filtered/zeroed at read time rather
 * than migrated — the underlying tmpdir-keyed transcripts are
 * unrecoverable, so there is nothing to migrate to. By design, not a
 * migration candidate.
 */

import type { DeckKind } from '#/main/deck-types.ts'
import { isCwdKeyedResume } from '#/main/ai/provider.ts'
import type { DeckSessionRecord } from '#/main/ai/session-store.ts'

export interface ResumeStrategy {
  /** The record to hand the backend, with stale `providerSessionId`
   *  zeroed when applicable. Never mutates the input. */
  effectiveRecord: DeckSessionRecord
  /** True when the backend's resume key (if it has one) still refers
   *  to a reachable transcript across deck reopens. Drives:
   *    - the CLI adapter's "skip saveSession" decision (no point in
   *      a row that future binds can't reach)
   *    - the renderer's "show History button" decision (same reason)
   *    - whether `chats:list` filters the row out as legacy debris.
   *  pi-agent backends always get true here; cwd-keyed CLI providers
   *  only get true on Source decks. */
  resumeSurvivesReopen: boolean
}

export function decideResumeStrategy(
  record: DeckSessionRecord,
  deckKind: DeckKind,
): ResumeStrategy {
  const resumeSurvivesReopen = !isCwdKeyedResume(record.provider) || deckKind === 'source'
  // Short-circuit: if the resume hint is still reachable, or if the
  // record is already a draft (no hint to invalidate), nothing to
  // adjust. Keeps `bindNew`'s "stale resume hint dropped" log
  // condition from misfiring on freshly-minted records.
  if (resumeSurvivesReopen || record.kind === 'draft') {
    return { effectiveRecord: record, resumeSurvivesReopen }
  }
  // Demote: the on-disk record is `active` but the resume hint won't
  // work for this deck.kind (Pack+CLI). Hand back a draft built from
  // the same identity — the backend will mint a fresh resume key.
  return {
    effectiveRecord: {
      kind: 'draft',
      id: record.id,
      provider: record.provider,
      createdMs: record.createdMs,
      lastUsedMs: record.lastUsedMs,
    },
    resumeSurvivesReopen,
  }
}
