import { useEffect, useState } from 'react'
import { useI18n } from '#/renderer/stores/i18n.ts'
import { Button, IconButton } from '#/renderer/components/ui/Button.tsx'
import { cn } from '#/renderer/lib/cn.ts'
import type { ProviderId } from '#/main/secrets.ts'
import type { Settings } from '#/main/settings.ts'
import { Field } from '#/renderer/components/SettingsOverlay/bits.tsx'
import {
  BASEURL_HINT_KEY,
  BUILTIN_IDS,
  BUILTIN_LABELS,
  CUSTOM_IDS,
  CUSTOM_LABEL_KEY,
  RECOMMENDED_MODEL,
} from '#/renderer/components/SettingsOverlay/providers.ts'

export function AiTab() {
  const t = useI18n((s) => s.t)
  return (
    <div className="flex flex-col gap-6">
      <AiGroup />
      <EncryptionWarning t={t} />
    </div>
  )
}

function AiGroup() {
  const t = useI18n((s) => s.t)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [provider, setProvider] = useState<ProviderId>('anthropic')
  const [builtinModel, setBuiltinModel] = useState<Record<string, string>>({
    anthropic: '',
    openai: '',
    google: '',
  })
  const [custom, setCustom] = useState<Record<string, { baseUrl: string; model: string }>>({
    'custom-openai': { baseUrl: '', model: '' },
    'custom-anthropic': { baseUrl: '', model: '' },
    'custom-responses': { baseUrl: '', model: '' },
  })
  const [configured, setConfigured] = useState<Partial<Record<ProviderId, boolean>>>({})
  const [apiKey, setApiKey] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [pingStatus, setPingStatus] = useState<{ kind: '' | 'ok' | 'err'; msg: string }>({
    kind: '',
    msg: '',
  })

  useEffect(() => {
    void (async () => {
      const s = await window.deck.settings.load()
      setSettings(s)
      setProvider(s.ai.provider)
      setBuiltinModel({ ...s.ai.builtinModel })
      setCustom({ ...s.ai.custom })
      const cfg = await window.deck.settings.listConfiguredProviders()
      setConfigured(cfg)
    })()
  }, [])

  const isCustom = provider.startsWith('custom-')
  const providerLabel = (p: ProviderId) =>
    BUILTIN_LABELS[p] ?? t(CUSTOM_LABEL_KEY[p] as any)

  const modelValue = isCustom ? custom[provider]?.model ?? '' : builtinModel[provider] ?? ''
  const recommended = RECOMMENDED_MODEL[provider] ?? ''
  const modelHint = isCustom
    ? ''
    : recommended
      ? t('settings.model.hint.builtinRecommended', { model: recommended })
      : t('settings.model.hint.builtin')
  const baseUrlValue = isCustom ? custom[provider]?.baseUrl ?? '' : ''
  const baseUrlHintKey = isCustom ? BASEURL_HINT_KEY[provider] : undefined
  const baseUrlHint = baseUrlHintKey ? t(baseUrlHintKey as any) : ''

  const keyHint = configured[provider]
    ? t('settings.apiKey.status.saved', { provider: providerLabel(provider) })
    : ''

  if (!settings) return null

  async function onSave() {
    setPingStatus({ kind: '', msg: t('settings.status.saving') })
    try {
      await window.deck.settings.save({
        ai: {
          provider,
          builtinModel: { ...builtinModel } as Settings['ai']['builtinModel'],
          custom: { ...custom } as Settings['ai']['custom'],
        },
      })
      const newKey = apiKey.trim()
      if (newKey) {
        await window.deck.settings.setApiKey(provider, newKey)
        setConfigured((c) => ({ ...c, [provider]: true }))
        setApiKey('')
      }
      setPingStatus({ kind: 'ok', msg: t('settings.status.saved') })
    } catch (e) {
      setPingStatus({ kind: 'err', msg: e instanceof Error ? e.message : String(e) })
    }
  }

  async function onClearKey() {
    setPingStatus({ kind: '', msg: t('settings.status.clearing') })
    try {
      await window.deck.settings.clearApiKey(provider)
      setConfigured((c) => ({ ...c, [provider]: false }))
      setPingStatus({
        kind: 'ok',
        msg: t('settings.status.clearedKey', { provider: providerLabel(provider) }),
      })
    } catch (e) {
      setPingStatus({ kind: 'err', msg: e instanceof Error ? e.message : String(e) })
    }
  }

  async function onPing() {
    setPingStatus({ kind: '', msg: t('settings.status.pinging') })
    try {
      const r = await window.deck.settings.ping()
      if (r.ok) {
        setPingStatus({
          kind: 'ok',
          msg: t('settings.status.pingOk', {
            provider: r.provider ?? '',
            model: r.model ?? '',
            text: r.text || t('chat.status.empty'),
          }),
        })
      } else {
        setPingStatus({ kind: 'err', msg: r.error ?? t('settings.status.pingFailed') })
      }
    } catch (e) {
      setPingStatus({ kind: 'err', msg: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <Field label={t('settings.provider')}>
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value as ProviderId)}
          className="h-9 rounded-md border border-line-2 bg-surface px-2.5 text-[13px] text-ink"
        >
          <optgroup label={t('settings.provider.builtin')}>
            {BUILTIN_IDS.map((p) => (
              <option key={p} value={p}>
                {providerLabel(p)}
              </option>
            ))}
          </optgroup>
          <optgroup label={t('settings.provider.custom')}>
            {CUSTOM_IDS.map((p) => (
              <option key={p} value={p}>
                {providerLabel(p)}
              </option>
            ))}
          </optgroup>
        </select>
      </Field>

      {isCustom && (
        <Field label={t('settings.baseUrl')} hint={baseUrlHint}>
          <input
            value={baseUrlValue}
            onChange={(e) =>
              setCustom((c) => ({
                ...c,
                [provider]: { ...c[provider], baseUrl: e.target.value },
              }))
            }
            placeholder="https://…/v1"
            spellCheck={false}
            autoComplete="off"
            className="h-9 rounded-md border border-line-2 bg-surface px-2.5 text-[13px] text-ink"
          />
        </Field>
      )}

      <Field label={t('settings.model')} hint={modelHint}>
        <input
          value={modelValue}
          onChange={(e) => {
            const v = e.target.value
            if (isCustom) setCustom((c) => ({ ...c, [provider]: { ...c[provider], model: v } }))
            else setBuiltinModel((m) => ({ ...m, [provider]: v }))
          }}
          placeholder={isCustom ? t('settings.model.placeholder.custom') : recommended}
          spellCheck={false}
          autoComplete="off"
          className="h-9 rounded-md border border-line-2 bg-surface px-2.5 text-[13px] text-ink"
        />
      </Field>

      <Field label={t('settings.apiKey')} hint={keyHint}>
        <div className="grid grid-cols-[1fr_auto] items-center gap-2">
          <input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            type={revealed ? 'text' : 'password'}
            placeholder={
              configured[provider]
                ? t('settings.apiKey.placeholder.saved')
                : t('settings.apiKey.placeholder.empty')
            }
            autoComplete="off"
            className="h-9 rounded-md border border-line-2 bg-surface px-2.5 font-mono text-[12px] text-ink"
          />
          <IconButton
            onClick={() => setRevealed((v) => !v)}
            title={t('settings.toggleReveal.title')}
            aria-label={t('aria.toggleKey')}
            data-revealed={revealed}
            className="h-9 w-9"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {revealed ? (
                <>
                  <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a19.77 19.77 0 0 1 5.06-5.94" />
                  <path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a19.77 19.77 0 0 1-3.16 4.19" />
                  <path d="M1 1l22 22" />
                </>
              ) : (
                <>
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </>
              )}
            </svg>
          </IconButton>
        </div>
      </Field>

      <div className="mt-1 flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => void onSave()}>
          {t('settings.save')}
        </Button>
        <Button variant="danger" onClick={() => void onClearKey()}>
          {t('settings.clearKey')}
        </Button>
        <Button onClick={() => void onPing()}>{t('settings.testConnection')}</Button>
        <span
          className={cn(
            'ml-auto min-h-4 text-[12px] text-ink-3',
            pingStatus.kind === 'ok' && 'text-[#2f855a] dark:text-[#6ddb9a]',
            pingStatus.kind === 'err' && 'text-[#c43a3a] dark:text-[#ff7a7a]',
          )}
        >
          {pingStatus.msg}
        </span>
      </div>
    </section>
  )
}

function EncryptionWarning({ t }: { t: ReturnType<typeof useI18n.getState>['t'] }) {
  const [available, setAvailable] = useState(true)
  useEffect(() => {
    void window.deck.settings.encryptionAvailable().then((v) => setAvailable(!!v))
  }, [])
  if (available) return null
  return (
    <div className="rounded-lg bg-[#fff4e5] p-3.5 text-[12px] leading-snug text-[#7a4a00] dark:bg-[rgb(255_180_80/0.1)] dark:text-[#ffc37d]">
      {t('settings.encryption.unavailable')}
    </div>
  )
}
