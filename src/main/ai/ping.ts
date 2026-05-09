import { streamSimple, type Context } from '@earendil-works/pi-ai'
import { buildModel } from '#/main/ai/provider.ts'
import { t } from '#/main/i18n/index.ts'
import { getSecret, type ProviderId } from '#/main/secrets.ts'
import { getSettings, resolveModel, type CustomProviderConfig } from '#/main/settings.ts'

export interface PingResult {
  ok: boolean
  /** Assistant text (accumulated from stream) when ok. */
  text?: string
  /** Human-readable error when !ok. */
  error?: string
  /** Provider/model used, so the UI can confirm what was actually exercised. */
  provider?: ProviderId
  model?: string
}

/**
 * Optional overrides for `pingAi`. The Settings UI passes the user's
 * *currently typed* form values (provider/model/key/custom baseUrl) so
 * Test Connection validates the in-flight edit, not what's persisted —
 * otherwise typing a new key, hitting Test, and seeing a stale-key
 * failure would be misleading. Any field left undefined falls back to
 * the saved settings / keychain.
 */
export interface PingOverrides {
  provider?: ProviderId
  model?: string
  apiKey?: string
  /** Only consulted for custom providers; safe to pass for builtins (ignored). */
  custom?: Partial<Record<'custom-openai' | 'custom-anthropic' | 'custom-responses', CustomProviderConfig>>
}

/**
 * Send a one-shot "ping" to the configured provider/model and return the
 * assistant's reply. Used to validate settings end-to-end (key works,
 * network reaches the provider, the model id is accepted).
 */
export async function pingAi(overrides: PingOverrides = {}): Promise<PingResult> {
  const settings = await getSettings()
  const provider = overrides.provider ?? settings.ai.provider
  const modelId =
    overrides.model && overrides.model.trim().length > 0
      ? overrides.model.trim()
      : resolveModel(provider === settings.ai.provider ? settings : { ...settings, ai: { ...settings.ai, provider } })

  // Prefer the live value (user typing in Settings) over whatever's in
  // keychain. Empty string means "explicitly empty" — still falls back
  // to keychain so a Test with no field input tests the saved key.
  const apiKey = overrides.apiKey?.trim() || (await getSecret(provider))
  if (!apiKey) {
    return {
      ok: false,
      // Same copy as the composer's send-disabled hint — both flag the
      // exact same configuration gap. Env-var fallback is deliberately
      // not honored here; see checkAiReadiness for the rationale.
      error: t('composer.disabled.no-key'),
      provider,
      model: modelId,
    }
  }

  // Custom providers need baseUrl; merge override → saved.
  const mergedCustom = { ...settings.ai.custom, ...(overrides.custom ?? {}) } as typeof settings.ai.custom

  let model
  try {
    model = buildModel({
      provider,
      model: modelId,
      custom: mergedCustom,
    })
  } catch (e) {
    return {
      ok: false,
      error: `Cannot build model for ${provider}: ${(e as Error).message}`,
      provider,
      model: modelId,
    }
  }

  const context: Context = {
    systemPrompt: 'You are a connectivity test. Reply with a short "pong" and nothing else.',
    messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }],
  }

  try {
    const events = streamSimple(model, context, { apiKey, maxTokens: 64 })
    let text = ''
    for await (const ev of events) {
      if (ev.type === 'text_delta') text += ev.delta
      if (ev.type === 'error') {
        const msg = ev.error.errorMessage ?? `Provider stream ${ev.reason}`
        return { ok: false, error: msg, provider, model: modelId }
      }
    }
    return { ok: true, text: text.trim(), provider, model: modelId }
  } catch (e) {
    return { ok: false, error: (e as Error).message, provider, model: modelId }
  }
}
