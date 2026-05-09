import { streamSimple, type Context } from '@earendil-works/pi-ai'
import { buildModel } from '#/main/ai/provider.ts'
import { t } from '#/main/i18n/index.ts'
import { getSecret, type ProviderId } from '#/main/secrets.ts'
import { getSettings, resolveModel } from '#/main/settings.ts'

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
 * Send a one-shot "ping" to the configured provider/model and return the
 * assistant's reply. Used to validate settings end-to-end (key works,
 * network reaches the provider, the model id is accepted).
 */
export async function pingAi(): Promise<PingResult> {
  const settings = await getSettings()
  const { provider } = settings.ai
  const modelId = resolveModel(settings)

  const apiKey = await getSecret(provider)
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

  let model
  try {
    model = buildModel({
      provider,
      model: modelId,
      custom: settings.ai.custom,
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
