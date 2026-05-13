import { DEFAULT_COMPACTION_SETTINGS } from '@earendil-works/pi-coding-agent'
import type { ThinkingLevel } from '@earendil-works/pi-agent-core'
import { app } from 'electron'
import { existsSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ProviderId } from '#/main/secrets.ts'
import { createSerialQueue } from '#/main/util/serial-queue.ts'

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
 * UI preferences.
 *
 * Both `lang` and `theme` are persisted to settings.json and resolved by
 * main; renderers pull the active state via IPC and subscribe to
 * change broadcasts. Resolution uses the OS — `app.getLocale()` for
 * lang, `nativeTheme.shouldUseDarkColors` for theme — when the value
 * is 'auto'.
 *
 * Initial paint avoids a flash by passing the resolved theme through
 * `loadFile`'s `?theme=` query (see `window-shell.ts::initialThemeQuery`);
 * each HTML's inline boot script reads it and stamps `<html data-theme>`
 * synchronously before any CSS evaluates.
 */
export interface UiSettings {
  /** 'auto' resolves to the OS language at startup; an explicit value
   *  overrides. See src/main/i18n/index.ts::resolveLang. */
  lang: 'en' | 'zh' | 'ko' | 'auto'
  /** 'auto' follows the OS appearance (light/dark) live; explicit picks
   *  pin the resolved theme regardless of OS changes. See
   *  `src/main/theme.ts`. */
  theme: 'auto' | 'light' | 'dark'
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
  /**
   * Reasoning / "thinking" level forwarded to the Agent each turn.
   * Models without reasoning support silently ignore this. Default is
   * `medium` — the obvious default once we surface the toggle, since
   * the agent's editing tasks (read → reason → edit) benefit from
   * deliberate reasoning, and providers that don't support it fall
   * back automatically.
   */
  thinkingLevel: ThinkingLevel
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

export const VALID_THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]

export const DEFAULT_SETTINGS: Settings = {
  ai: {
    provider: 'anthropic',
    builtinModel: { ...DEFAULT_BUILTIN_MODELS },
    custom: {
      'custom-openai': { ...EMPTY_CUSTOM },
      'custom-anthropic': { ...EMPTY_CUSTOM },
      'custom-responses': { ...EMPTY_CUSTOM },
    },
    thinkingLevel: 'medium',
  },
  ui: { lang: 'auto', theme: 'auto' },
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
  // CLI providers manage their own model selection via their own config /
  // CLI flags. We surface an empty string so callers that path through
  // here for display purposes don't blow up; the CLI session adapter
  // ignores this entirely.
  if (provider === 'claude-cli') return ''
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
        builtinModel?: Partial<AiSettings['builtinModel']>
        custom?: Partial<AiSettings['custom']>
        thinkingLevel?: unknown
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
    const rawProvider = parsed.ai?.provider as ProviderId | undefined
    const provider: ProviderId =
      rawProvider === 'anthropic' ||
      rawProvider === 'openai' ||
      rawProvider === 'google' ||
      rawProvider === 'custom-openai' ||
      rawProvider === 'custom-anthropic' ||
      rawProvider === 'custom-responses' ||
      rawProvider === 'claude-cli'
        ? rawProvider
        : DEFAULT_SETTINGS.ai.provider
    const uiLang =
      parsed.ui?.lang === 'en' || parsed.ui?.lang === 'zh' || parsed.ui?.lang === 'ko' || parsed.ui?.lang === 'auto'
        ? parsed.ui.lang
        : DEFAULT_SETTINGS.ui.lang
    const uiTheme =
      parsed.ui?.theme === 'auto' || parsed.ui?.theme === 'light' || parsed.ui?.theme === 'dark'
        ? parsed.ui.theme
        : DEFAULT_SETTINGS.ui.theme
    const rawThinking = parsed.ai?.thinkingLevel
    const thinkingLevel: ThinkingLevel = VALID_THINKING_LEVELS.includes(rawThinking as ThinkingLevel)
      ? (rawThinking as ThinkingLevel)
      : DEFAULT_SETTINGS.ai.thinkingLevel
    cache = {
      ai: {
        provider,
        builtinModel: mergedBuiltin,
        custom: mergedCustom,
        thinkingLevel,
      },
      ui: { lang: uiLang, theme: uiTheme },
      compaction: {
        ...DEFAULT_SETTINGS.compaction,
        ...(parsed.compaction ?? {}),
      },
    }
  } catch (e) {
    // Corrupt file — reset to defaults. The next write will overwrite it.
    // Log so the user can see in DevTools / console why their saved
    // provider/keys/model are gone; without this they'd silently start
    // over on Anthropic + sonnet defaults.
    const reason = e instanceof Error ? e.message : String(e)
    console.warn(`[settings] settings.json could not be loaded (${reason}); resetting to defaults`)
    cache = structuredClone(DEFAULT_SETTINGS)
  }
  return cache
}

export async function getSettings(): Promise<Settings> {
  return load()
}

// Concurrent updateSettings calls would otherwise race on the shared
// `.tmp` path (writeFile+rename pair) and on the read-modify-write of
// `cache`. See `createSerialQueue` for the chain semantics.
const { enqueue: enqueueWrite } = createSerialQueue()

/**
 * Shallow-merge `patch` into the current settings and persist. Top-level
 * keys (`ai`, `ui`, `compaction`) are spread-merged with the existing
 * value, so a caller that only knows about `ui.theme` doesn't have to
 * re-supply `ui.lang`. `ai.custom` and `ai.builtinModel` are independently
 * merged for the same reason — without that a patch updating one
 * provider's model would wipe the others.
 */
export type SettingsPatch = {
  ai?: Partial<AiSettings> & {
    builtinModel?: Partial<AiSettings['builtinModel']>
    custom?: Partial<AiSettings['custom']>
  }
  ui?: Partial<UiSettings>
  compaction?: Partial<CompactionSettings>
}

export function updateSettings(patch: SettingsPatch): Promise<Settings> {
  return enqueueWrite(() => doUpdate(patch))
}

async function doUpdate(patch: SettingsPatch): Promise<Settings> {
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
  const nextCompaction: CompactionSettings = patch.compaction
    ? { ...current.compaction, ...patch.compaction }
    : current.compaction
  const next: Settings = { ai: nextAi, ui: nextUi, compaction: nextCompaction }
  const file = settingsFile()
  const tmp = file + '.tmp'
  await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8')
  await rename(tmp, file)
  cache = next
  return next
}
