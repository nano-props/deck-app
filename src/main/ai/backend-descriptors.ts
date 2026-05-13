/**
 * Per-provider backend metadata, in one place.
 *
 * Background — what was wrong before:
 * The "what does this provider need / how does it persist / how do we
 * detect it / what's its label" answers were spread across at least
 * 5 files: secrets.ts (`isCliProvider`), ai/provider.ts
 * (`PROVIDER_LABEL`, `isCwdKeyedResume`), ai/readiness.ts (the API-
 * key-vs-CLI dispatch), ai-session-manager.ts (the factory dispatch),
 * and renderer/components/SettingsOverlay/providers.ts (UI labels +
 * grouping). Adding a new provider meant 8+ separate edits. Worse,
 * the predicates `isCliProvider` and `isCwdKeyedResume` happened to
 * be true for the same set today (only `claude-cli`), so it was
 * easy to write code that used the wrong one and have it accidentally
 * keep working.
 *
 * The descriptor below collapses the main-process facts into a single
 * record per provider. Predicates like `isCliProvider` /
 * `isCwdKeyedResume` are now thin wrappers over `kind` /
 * `transcriptStorage`, so adding a hypothetical new CLI provider
 * (codex-cli, gemini-cli) is a single descriptor entry plus its
 * factory. Renderer-side display tables (BUILTIN_LABELS,
 * CUSTOM_LABEL_KEY, etc.) are intentionally NOT folded in here yet —
 * they're UI presentation concerns and the renderer doesn't read
 * main-process modules; that consolidation is a follow-up.
 *
 * Note: factories are imported lazily inside `getBackendDescriptor`
 * to avoid a hard cycle at module load — the CLI factory pulls in
 * detect.ts which pulls in path utilities, and we'd rather keep the
 * descriptor table itself import-free of session machinery.
 */

import type { ProviderId } from '#/main/secrets.ts'

/** How the backend invokes the LLM. Drives the auth model, the
 *  readiness check, and which factory the manager dispatches to. */
export type BackendKind = 'pi-agent' | 'cli'

/** Where the backend stores transcripts on disk. Drives
 *  `decideResumeStrategy` — only `cwd-keyed` storage cares about
 *  `deck.kind` (Pack tmpdirs change cwd-hash on each open). */
export type TranscriptStorage =
  /** Under our `userData/chats/<deckId>/` directory, keyed off the
   *  deck's stable `sourcePath`. Survives reopen, app restarts, and
   *  user moves the .deck file (sourcePath changes but record
   *  travels with it via deckChatId). pi-agent backends. */
  | 'app-userData'
  /** Under the backend's own directory, keyed off the runtime cwd.
   *  Claude Code's `~/.claude/projects/<cwd-hash>/`. Survives reopen
   *  ONLY when cwd is stable across opens (Source decks). Pack decks
   *  break this — the resume key becomes unreachable. */
  | 'cwd-keyed'

export interface BackendDescriptor {
  id: ProviderId
  kind: BackendKind
  /** Where the backend stores conversation transcripts. */
  transcriptStorage: TranscriptStorage
}

/** Source of truth — every ProviderId must appear here exactly once. */
const DESCRIPTORS: Record<ProviderId, BackendDescriptor> = {
  anthropic: { id: 'anthropic', kind: 'pi-agent', transcriptStorage: 'app-userData' },
  openai: { id: 'openai', kind: 'pi-agent', transcriptStorage: 'app-userData' },
  google: { id: 'google', kind: 'pi-agent', transcriptStorage: 'app-userData' },
  'custom-openai': { id: 'custom-openai', kind: 'pi-agent', transcriptStorage: 'app-userData' },
  'custom-anthropic': { id: 'custom-anthropic', kind: 'pi-agent', transcriptStorage: 'app-userData' },
  'custom-responses': { id: 'custom-responses', kind: 'pi-agent', transcriptStorage: 'app-userData' },
  'claude-cli': { id: 'claude-cli', kind: 'cli', transcriptStorage: 'cwd-keyed' },
}

export function getBackendDescriptor(id: ProviderId): BackendDescriptor {
  return DESCRIPTORS[id]
}
