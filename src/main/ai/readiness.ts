import { getSecret } from '#/main/secrets.ts'
import { getSettings, resolveModel } from '#/main/settings.ts'
import { isBuiltin, isKnownBuiltinModel, type AiReadiness, type AiUnreadyReason } from '#/main/ai/provider.ts'

/**
 * Check whether the current AI settings can actually stream a turn.
 *
 * The renderer calls this through IPC to gate the composer's Send button.
 * Logic mirrors `buildModel(...)` + the runtime API-key check.
 *
 * Order of checks matches the user's likely fix path: prove the key is
 * there (most common gap), then the endpoint config (custom only), then
 * the model id (catalog drift). The first failure short-circuits.
 *
 * Note: pi-ai also falls back to environment variables (ANTHROPIC_API_KEY
 * etc.) at stream time, but we deliberately ignore that path here. Deck
 * is a desktop product; the user-facing source of truth is the Settings
 * UI. Honoring an env-var-only key would put the composer into a state
 * where Settings says "no key set" but Send still works — confusing for
 * non-technical users. The trade-off is that developers running from a
 * shell with exported keys still need to copy the key into Settings.
 */
export async function checkAiReadiness(): Promise<AiReadiness> {
  const settings = await getSettings()
  const provider = settings.ai.provider

  // 1. API key — must be stored via Settings (env vars deliberately ignored).
  const key = await getSecret(provider)
  if (!key) return notReady('no-key')

  if (isBuiltin(provider)) {
    // 2a. Builtin model must still be in pi-ai's registry. Drift here
    //     would surface as a "model not found" throw on first send;
    //     better to gate up-front.
    const modelId = resolveModel(settings)
    if (!isKnownBuiltinModel(provider, modelId)) return notReady('unknown-builtin-model')
    return ready()
  }

  // 2b. Custom endpoint: both baseUrl and model id must be non-empty —
  //     buildCustomModel throws otherwise.
  const config = settings.ai.custom[provider]
  if (!config?.baseUrl?.trim()) return notReady('no-base-url')
  if (!config?.model?.trim()) return notReady('no-model-id')
  return ready()
}

function ready(): AiReadiness {
  return { ready: true }
}
function notReady(reason: AiUnreadyReason): AiReadiness {
  return { ready: false, reason }
}
