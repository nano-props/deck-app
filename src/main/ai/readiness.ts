import { getSecret, isCliProvider, type ProviderId } from '#/main/secrets.ts'
import { getSettings, resolveModel } from '#/main/settings.ts'
import { isBuiltin, isKnownBuiltinModel, type AiReadiness, type AiUnreadyReason } from '#/main/ai/provider.ts'
import { detectClaudeCli } from '#/main/ai/claude-cli/detect.ts'

/**
 * Check whether the current AI settings can actually stream a turn.
 *
 * The renderer calls this through IPC to gate the composer's Send button.
 * Logic mirrors what each session backend will do at send time:
 *   - CLI providers (claude-cli) → require the binary on PATH.
 *   - API providers → require an API key, plus model/endpoint config.
 *
 * Order of checks matches the user's likely fix path. The first failure
 * short-circuits.
 *
 * Note: pi-ai also falls back to environment variables (ANTHROPIC_API_KEY
 * etc.) at stream time, but we deliberately ignore that path here. Deck
 * is a desktop product; the user-facing source of truth is the Settings
 * UI. Honoring an env-var-only key would put the composer into a state
 * where Settings says "no key set" but Send still works — confusing for
 * non-technical users. The trade-off is that developers running from a
 * shell with exported keys still need to copy the key into Settings.
 * (CLI providers are the exception: the CLI handles its own auth and
 * may legitimately consume env vars or its own login state.)
 */
/**
 * Probe whether AI can stream a turn for `forProvider`. Defaults to
 * the user's current `settings.ai.provider` — that's the right
 * reading for the composer Send-button gate ("can the next NEW chat
 * succeed?"). Backends pass their locked deck-session provider so
 * the gate runs against the conversation's actual provider, not a
 * setting the user just changed.
 */
export async function checkAiReadiness(forProvider?: ProviderId): Promise<AiReadiness> {
  const settings = await getSettings()
  const provider = forProvider ?? settings.ai.provider

  // CLI providers gate on the binary being installed instead of an API
  // key — auth is the CLI's problem (login state lives in its own
  // config). A missing binary surfaces as `no-cli` so the renderer can
  // produce an actionable hint distinct from missing keys.
  if (isCliProvider(provider)) {
    const detected = await detectClaudeCli()
    if (!detected.found) return notReady('no-cli')
    return ready()
  }

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
  //     buildCustomModel throws otherwise. By construction of the
  //     branches above, `provider` is one of the custom-* ids here.
  const customId = provider as keyof typeof settings.ai.custom
  const config = settings.ai.custom[customId]
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
