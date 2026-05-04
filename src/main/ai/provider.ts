import { getModel, type Api, type KnownProvider, type Model } from '@mariozechner/pi-ai'
import { isCustomProvider, type ProviderId } from '#/main/secrets.ts'
import type { CustomProviderConfig } from '#/main/settings.ts'

/**
 * Builtin-only subset of ProviderId — the three providers whose models live
 * in pi-ai's generated registry and get validated against it.
 */
export type BuiltinProviderId = Extract<ProviderId, 'anthropic' | 'openai' | 'google'>

export type CustomProviderId = Extract<ProviderId, `custom-${string}`>

/**
 * Curated model lineup per builtin provider. We expose fewer choices than
 * the full pi-ai registry on purpose — the Editor is a focused tool, not a
 * model playground. Add/remove here when we want to surface or hide a
 * model.
 *
 * Ids must match pi-ai's generated registry. See
 * `node_modules/@mariozechner/pi-ai/dist/models.generated.js` for the
 * canonical list.
 */
export const MODEL_CATALOG: Record<BuiltinProviderId, readonly string[]> = {
  anthropic: ['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-haiku-4-5'],
  openai: ['gpt-5.1', 'gpt-5', 'gpt-5-mini'],
  google: ['gemini-3-pro-preview', 'gemini-3-flash', 'gemini-2.5-pro'],
}

/**
 * Human-visible labels. Custom entries tell the user which wire protocol
 * they're targeting, because that determines baseUrl semantics.
 */
export const PROVIDER_LABEL: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  'custom-openai': 'Custom (OpenAI-compatible)',
  'custom-anthropic': 'Custom (Anthropic-compatible)',
  'custom-responses': 'Custom (OpenAI Responses)',
}

/**
 * Map a custom ProviderId to the pi-ai `api` dispatch key. pi-ai uses this
 * to pick the right protocol adapter when it sees a Model with no registry
 * entry.
 */
const CUSTOM_API: Record<CustomProviderId, Api> = {
  'custom-openai': 'openai-completions',
  'custom-anthropic': 'anthropic-messages',
  'custom-responses': 'openai-responses',
}

export function isBuiltin(id: ProviderId): id is BuiltinProviderId {
  return !isCustomProvider(id)
}

/**
 * Resolve a builtin `(provider, modelId)` pair into a pi-ai `Model`.
 * Throws with a user-readable message if the id isn't in the registry.
 */
function resolveBuiltin(provider: BuiltinProviderId, modelId: string): Model<any> {
  return getModel(provider as KnownProvider, modelId as never)
}

/**
 * Synthesize a pi-ai Model for a custom endpoint. pi-ai's streamSimple only
 * reads `{ api, baseUrl, id }` plus optional `headers`/`maxTokens` — the
 * rest of the Model fields (cost, contextWindow, etc.) are for UI display
 * in pi's own tools. We fill them with zeros/placeholders; our Editor code
 * must NOT show cost estimates for custom models (no reliable source).
 */
function buildCustomModel(provider: CustomProviderId, config: CustomProviderConfig): Model<any> {
  if (!config.baseUrl) throw new Error(`Base URL is not set for ${PROVIDER_LABEL[provider]}`)
  if (!config.model) throw new Error(`Model id is not set for ${PROVIDER_LABEL[provider]}`)
  return {
    id: config.model,
    name: config.model,
    api: CUSTOM_API[provider],
    provider,
    baseUrl: config.baseUrl.replace(/\/+$/, ''),
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
  }
}

/**
 * Single entry point the rest of the app uses. Takes the persisted settings
 * shape and returns a ready-to-stream Model. Surface errors from here
 * carry user-actionable messages (empty baseUrl, unknown builtin model).
 *
 * `model` is the resolved id for the given provider — builtin providers
 * index into the pi-ai registry, custom providers use whatever string the
 * endpoint understands. Callers should get this from `resolveModel(settings)`
 * so builtin vs custom routing stays in one place.
 */
export function buildModel(params: {
  provider: ProviderId
  model: string
  custom: Record<CustomProviderId, CustomProviderConfig>
}): Model<any> {
  if (isBuiltin(params.provider)) {
    return resolveBuiltin(params.provider, params.model)
  }
  const config = params.custom[params.provider]
  return buildCustomModel(params.provider, config)
}

/**
 * Sanity-check a model id before persisting it in settings, for the builtin
 * case only — custom endpoints accept any string and we rely on the ping
 * round-trip to surface bad ids.
 */
export function isKnownBuiltinModel(provider: BuiltinProviderId, modelId: string): boolean {
  try {
    resolveBuiltin(provider, modelId)
    return true
  } catch {
    return false
  }
}

/**
 * Walk MODEL_CATALOG at startup and warn for any entry pi-ai no longer
 * recognizes. Prevents a silent UX break when pi-ai regenerates its
 * registry with a renamed/retired model id — the Settings form would
 * still let the user pick the stale id, and then `buildModel` would
 * throw on first use.
 *
 * Warns-only (doesn't throw): a stale default is better than refusing
 * to boot. The user can still recover by picking a different model.
 */
export function auditModelCatalog(): void {
  for (const provider of Object.keys(MODEL_CATALOG) as BuiltinProviderId[]) {
    for (const modelId of MODEL_CATALOG[provider]) {
      if (!isKnownBuiltinModel(provider, modelId)) {
        console.warn(
          `[ai] MODEL_CATALOG entry "${provider}/${modelId}" is not in pi-ai's registry — ` +
            `the Settings form will offer it but buildModel will fail. Update MODEL_CATALOG in src/main/ai/provider.ts.`,
        )
      }
    }
  }
}
