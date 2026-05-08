import { ipcMain } from 'electron'
import { pingAi } from '#/main/ai/ping.ts'
import { isBuiltin } from '#/main/ai/provider.ts'
import { checkAiReadiness } from '#/main/ai/readiness.ts'
import { chromeOnly } from '#/main/ipc/guard.ts'
import {
  clearSecret,
  isSecretsEncryptionAvailable,
  KNOWN_PROVIDERS,
  listConfiguredProviders,
  setSecret,
  type ProviderId,
} from '#/main/secrets.ts'
import { getSettings, updateSettings, type AiSettings } from '#/main/settings.ts'

/**
 * Settings overlay channels: load/save the plaintext config, store keys
 * in the OS keychain via secrets.ts, and run a one-shot `ping` against
 * the active provider to verify end-to-end connectivity.
 */
export function wireSettingsIpc(): void {
  ipcMain.handle(
    'settings:load',
    chromeOnly(async () => getSettings()),
  )
  ipcMain.handle(
    'settings:save',
    chromeOnly(async (_event, patch: unknown) => {
      if (!patch || typeof patch !== 'object') throw new Error('Invalid settings patch')
      const p = patch as {
        ai?: Partial<AiSettings> & {
          /** Legacy field: a single "active" model. If present, we slot it onto whichever builtin is now selected. */
          model?: string
        }
      }
      if (!p.ai) return getSettings()

      const current = await getSettings()

      const provider: ProviderId =
        typeof p.ai.provider === 'string' && (KNOWN_PROVIDERS as readonly string[]).includes(p.ai.provider)
          ? (p.ai.provider as ProviderId)
          : current.ai.provider

      // Per-provider builtin models. Accept either `builtinModel` (new) or
      // a single legacy `model` field (which the renderer sends alongside
      // a builtin provider switch). The legacy field writes onto the
      // selected builtin only; custom providers ignore it.
      const nextBuiltin = { ...current.ai.builtinModel }
      if (p.ai.builtinModel && typeof p.ai.builtinModel === 'object') {
        for (const key of Object.keys(nextBuiltin) as (keyof typeof nextBuiltin)[]) {
          const val = (p.ai.builtinModel as Partial<typeof nextBuiltin>)[key]
          if (typeof val === 'string' && val.trim().length > 0) nextBuiltin[key] = val.trim()
        }
      }
      if (typeof p.ai.model === 'string' && p.ai.model.trim().length > 0 && isBuiltin(provider)) {
        nextBuiltin[provider] = p.ai.model.trim()
      }

      const nextCustom = { ...current.ai.custom }
      if (p.ai.custom && typeof p.ai.custom === 'object') {
        for (const key of Object.keys(nextCustom) as (keyof typeof nextCustom)[]) {
          const entry = (p.ai.custom as Partial<typeof nextCustom>)[key]
          if (!entry) continue
          if (typeof entry.baseUrl !== 'string' || typeof entry.model !== 'string') {
            throw new Error(`Invalid custom config for ${key}`)
          }
          nextCustom[key] = { baseUrl: entry.baseUrl.trim(), model: entry.model.trim() }
        }
      }

      return updateSettings({
        ai: { provider, builtinModel: nextBuiltin, custom: nextCustom },
      })
    }),
  )
  ipcMain.handle(
    'settings:list-providers',
    chromeOnly(async () => listConfiguredProviders()),
  )
  ipcMain.handle(
    'settings:set-key',
    chromeOnly(async (_event, provider: unknown, key: unknown) => {
      if (typeof provider !== 'string' || !(KNOWN_PROVIDERS as readonly string[]).includes(provider)) {
        throw new Error(`Unknown provider: ${String(provider)}`)
      }
      if (typeof key !== 'string' || key.length === 0) {
        throw new Error('Empty key')
      }
      await setSecret(provider as ProviderId, key)
    }),
  )
  ipcMain.handle(
    'settings:clear-key',
    chromeOnly(async (_event, provider: unknown) => {
      if (typeof provider !== 'string' || !(KNOWN_PROVIDERS as readonly string[]).includes(provider)) {
        throw new Error(`Unknown provider: ${String(provider)}`)
      }
      await clearSecret(provider as ProviderId)
    }),
  )
  ipcMain.handle(
    'settings:encryption-available',
    chromeOnly(async () => isSecretsEncryptionAvailable()),
  )
  ipcMain.handle(
    'settings:ping',
    chromeOnly(async () => pingAi()),
  )
  ipcMain.handle(
    'settings:ai-readiness',
    chromeOnly(async () => checkAiReadiness()),
  )
}
