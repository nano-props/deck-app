import { DEFAULT_COMPACTION_SETTINGS } from '@mariozechner/pi-coding-agent'
import { app } from 'electron'
import { existsSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ProviderId } from '#/main/secrets.ts'

/**
 * Compaction settings — shape taken from pi's runtime default so the type
 * tracks whatever the installed pi version ships. pi's top-level
 * `CompactionSettings` export currently resolves to the settings-manager
 * (optional-fields) variant, which is not what `shouldCompact` expects.
 * Deriving from the default sidesteps that aliasing.
 */
export type CompactionSettings = typeof DEFAULT_COMPACTION_SETTINGS

/**
 * Plaintext user settings. Secrets (API keys) are NOT here — see secrets.ts.
 *
 * Shape is JSON; persisted to `userData/settings.json` atomically. Missing
 * fields fall back to defaults; unknown fields are preserved (forward
 * compatibility).
 */

/**
 * Per-custom-provider configuration. Retained separately from the active
 * selection so switching between a builtin and a custom provider doesn't
 * lose the custom's baseUrl / model id when the user flips back.
 */
export interface CustomProviderConfig {
  /** Full base URL, e.g. `https://openrouter.ai/api/v1` (no trailing slash enforced, but tolerated). */
  baseUrl: string
  /** Model identifier as the remote endpoint understands it. Free-form. */
  model: string
}

/**
 * UI preferences. Currently just language; theme stays in localStorage on
 * the renderer (it has to be resolved before any IPC round-trip to avoid a
 * white→dark flash, see the inline boot script in src/renderer/index.html).
 */
export interface UiSettings {
  /** 'auto' resolves to the OS language at startup; an explicit value
   *  overrides. See src/main/i18n/index.ts::resolveLang. */
  lang: 'en' | 'zh' | 'ko' | 'auto'
}

export interface AiSettings {
  /** Active provider used for AI chat. One key per id lives in secrets.ts. */
  provider: ProviderId
  /**
   * Model id per builtin provider. Separate buckets (not a single "active"
   * field) so flipping anthropic → openai → anthropic preserves each
   * provider's last choice. Reads go through `resolveModel(settings)` —
   * don't index this map directly from callers.
   */
  builtinModel: Record<'anthropic' | 'openai' | 'google', string>
  /** Persisted config for each custom flavor. Independent per wire protocol. */
  custom: Record<'custom-openai' | 'custom-anthropic' | 'custom-responses', CustomProviderConfig>
}

export interface Settings {
  ai: AiSettings
  ui: UiSettings
  /**
   * Context compaction thresholds. Shape is pi-coding-agent's
   * `CompactionSettings` verbatim — we reuse the type so pi upgrades keep
   * settings in sync without our translation layer drifting.
   *
   * `enabled` currently acts as a "warn the user when context is near
   * full" flag — pi's public API doesn't yet export `prepareCompaction`,
   * so automatic compaction is not wired up. The field stays here so the
   * wiring (and any future settings UI) only has to flip a boolean when
   * that export lands.
   */
  compaction: CompactionSettings
}

const EMPTY_CUSTOM: CustomProviderConfig = { baseUrl: '', model: '' }

/**
 * Default model id per builtin provider. Matches the top of each
 * MODEL_CATALOG list in ai/provider.ts. Per docs/deck.md §5.3 the
 * everyday driver is Claude Sonnet 4.6; users can flip to Opus 4.7 or
 * switch provider in the settings window.
 */
export const DEFAULT_BUILTIN_MODELS: AiSettings['builtinModel'] = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-5.1',
  google: 'gemini-3-pro-preview',
}

export const DEFAULT_SETTINGS: Settings = {
  ai: {
    provider: 'anthropic',
    builtinModel: { ...DEFAULT_BUILTIN_MODELS },
    custom: {
      'custom-openai': { ...EMPTY_CUSTOM },
      'custom-anthropic': { ...EMPTY_CUSTOM },
      'custom-responses': { ...EMPTY_CUSTOM },
    },
  },
  ui: { lang: 'auto' },
  compaction: { ...DEFAULT_COMPACTION_SETTINGS },
}

/**
 * Resolve the effective model id for the current provider. Single read
 * path so builtin vs custom routing is in one place.
 */
export function resolveModel(settings: Settings): string {
  const { provider, builtinModel, custom } = settings.ai
  if (provider === 'anthropic' || provider === 'openai' || provider === 'google') {
    return builtinModel[provider] || DEFAULT_BUILTIN_MODELS[provider]
  }
  return custom[provider].model
}

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

let cache: Settings | null = null
/**
 * In-flight `load()` promise. Concurrent callers (e.g. a getSettings
 * race against a doUpdate) used to each fire their own `readFile`; if
 * one finished after a write had landed, its assignment to `cache`
 * could overwrite the post-write state with the pre-write contents.
 * Sharing the promise gives all concurrent callers the same result and
 * keeps `cache` strictly monotonic: only the first read of a cold
 * cache touches disk, and once it resolves cache is the new floor.
 */
let inflight: Promise<Settings> | null = null

function load(): Promise<Settings> {
  if (cache) return Promise.resolve(cache)
  if (inflight) return inflight
  inflight = doLoad().finally(() => {
    inflight = null
  })
  return inflight
}

async function doLoad(): Promise<Settings> {
  const file = settingsFile()
  if (!existsSync(file)) {
    cache = structuredClone(DEFAULT_SETTINGS)
    return cache
  }
  try {
    const raw = await readFile(file, 'utf8')
    const parsed = JSON.parse(raw) as Partial<Settings> & {
      ai?: {
        provider?: ProviderId
        /** Legacy pre-0.2 field: a single "active" model. Migrated into `builtinModel[provider]`. */
        model?: string
        builtinModel?: Partial<AiSettings['builtinModel']>
        custom?: Partial<AiSettings['custom']>
      }
      ui?: Partial<UiSettings>
      compaction?: Partial<CompactionSettings>
    }
    const mergedCustom = { ...DEFAULT_SETTINGS.ai.custom }
    for (const key of Object.keys(mergedCustom) as (keyof AiSettings['custom'])[]) {
      const entry = parsed.ai?.custom?.[key]
      if (entry && typeof entry.baseUrl === 'string' && typeof entry.model === 'string') {
        mergedCustom[key] = { baseUrl: entry.baseUrl, model: entry.model }
      }
    }
    const mergedBuiltin: AiSettings['builtinModel'] = { ...DEFAULT_BUILTIN_MODELS }
    for (const key of Object.keys(mergedBuiltin) as (keyof AiSettings['builtinModel'])[]) {
      const val = parsed.ai?.builtinModel?.[key]
      if (typeof val === 'string' && val.length > 0) mergedBuiltin[key] = val
    }
    // Migrate the pre-split `ai.model` onto the provider it belonged to.
    // The field was only ever meaningful for the *active* builtin, so we
    // slot it onto whichever builtin is currently selected. Custom
    // providers already read from ai.custom[id].model and are unaffected.
    const provider = (parsed.ai?.provider ?? DEFAULT_SETTINGS.ai.provider) as ProviderId
    if (
      typeof parsed.ai?.model === 'string' &&
      parsed.ai.model.length > 0 &&
      (provider === 'anthropic' || provider === 'openai' || provider === 'google') &&
      !parsed.ai.builtinModel
    ) {
      mergedBuiltin[provider] = parsed.ai.model
    }
    const uiLang =
      parsed.ui?.lang === 'en' || parsed.ui?.lang === 'zh' || parsed.ui?.lang === 'ko' || parsed.ui?.lang === 'auto'
        ? parsed.ui.lang
        : DEFAULT_SETTINGS.ui.lang
    cache = {
      ai: {
        provider,
        builtinModel: mergedBuiltin,
        custom: mergedCustom,
      },
      ui: { lang: uiLang },
      compaction: {
        ...DEFAULT_SETTINGS.compaction,
        ...(parsed.compaction ?? {}),
      },
    }
  } catch {
    // Corrupt file — reset to defaults. The next write will overwrite it.
    cache = structuredClone(DEFAULT_SETTINGS)
  }
  return cache
}

export async function getSettings(): Promise<Settings> {
  return load()
}

/**
 * Tail of the write queue. Concurrent updateSettings calls would otherwise
 * race on the shared `.tmp` path (writeFile+rename pair) and on the
 * read-modify-write of `cache`. Chain each call onto the previous so
 * writes serialize without serializing reads.
 *
 * Errors in one update don't sink the chain — `.catch(() => {})` keeps
 * the tail resolvable so the next caller's await isn't poisoned.
 */
let writeQueue: Promise<unknown> = Promise.resolve()

/**
 * Shallow-merge `patch` into the current settings and persist. Callers that
 * need to change nested fields (e.g. just `ai.model`) should pass a fully
 * formed `ai` object — this intentionally doesn't deep-merge to avoid
 * partial-write ambiguity.
 *
 * Concurrent calls are serialized (see `writeQueue`) so two near-simultaneous
 * Save clicks can't clobber each other's `.tmp` file or interleave the
 * read-modify-write of `cache`.
 */
export function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = writeQueue.then(() => doUpdate(patch))
  // Swallow errors in the chain tail so one failure doesn't poison
  // subsequent updates; callers still see the rejection on their own
  // returned promise.
  writeQueue = next.catch(() => {})
  return next
}

async function doUpdate(patch: Partial<Settings>): Promise<Settings> {
  const current = await load()
  // Explicit-per-field merge instead of spread: `ai.custom` is a map of
  // three independent entries and we don't want a patch that only knows
  // about one of them to wipe the other two. Spread merges at the top
  // level only; this keeps `custom` entries distinct.
  const nextAi = patch.ai
    ? {
        ...current.ai,
        ...patch.ai,
        builtinModel: patch.ai.builtinModel
          ? { ...current.ai.builtinModel, ...patch.ai.builtinModel }
          : current.ai.builtinModel,
        custom: patch.ai.custom ? { ...current.ai.custom, ...patch.ai.custom } : current.ai.custom,
      }
    : current.ai
  const nextUi: UiSettings = patch.ui ? { ...current.ui, ...patch.ui } : current.ui
  const next: Settings = { ...current, ...patch, ai: nextAi, ui: nextUi }
  const file = settingsFile()
  const tmp = file + '.tmp'
  await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8')
  await rename(tmp, file)
  cache = next
  return next
}
