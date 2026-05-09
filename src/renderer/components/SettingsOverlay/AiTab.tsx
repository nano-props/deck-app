import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Eye, EyeOff, Trash2, X } from 'lucide-react'
import { useI18n } from '#/renderer/stores/i18n.ts'
import { IconButton } from '#/renderer/components/ui/Button.tsx'
import { Tooltip } from '#/renderer/components/ui/Tooltip.tsx'
import { Select } from '#/renderer/components/ui/Select.tsx'
import { TextInput } from '#/renderer/components/ui/TextInput.tsx'
import { cn } from '#/renderer/lib/cn.ts'
import type { ThinkingLevel } from '@earendil-works/pi-agent-core'
import type { ProviderId } from '#/main/secrets.ts'
import type { Settings } from '#/main/settings.ts'
import { Field, Segmented } from '#/renderer/components/SettingsOverlay/bits.tsx'
import {
  BASEURL_HINT_KEY,
  BUILTIN_IDS,
  BUILTIN_LABELS,
  CUSTOM_IDS,
  CUSTOM_LABEL_KEY,
  RECOMMENDED_MODEL,
} from '#/renderer/components/SettingsOverlay/providers.ts'

export function AiTab() {
  return (
    <div className="flex flex-col gap-6">
      <AiGroup />
      <EncryptionWarning />
    </div>
  )
}

// Footer status: a single discriminated union covers all states the
// auto-save + auto-ping pipeline can advertise. `saved` auto-fades to
// `idle` after 2s; everything else is sticky until the next event.
type Status =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'pinging' }
  | { kind: 'ok'; msg: string }
  | { kind: 'err'; msg: string }

const SAVE_DEBOUNCE_MS = 1500
const PING_DEBOUNCE_MS = 1000
const SAVED_FLASH_MS = 2000

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
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>('medium')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  // ---- Initial load --------------------------------------------------------
  useEffect(() => {
    void (async () => {
      // Run both reads in parallel — they're independent. Sequential
      // await flickers `keyHint` blank before the keychain check
      // resolves and reveals "Saved for X".
      const [s, cfg] = await Promise.all([
        window.deck.settings.load(),
        window.deck.settings.listConfiguredProviders(),
      ])
      setSettings(s)
      setProvider(s.ai.provider)
      setBuiltinModel({ ...s.ai.builtinModel })
      setCustom({ ...s.ai.custom })
      setThinkingLevel(s.ai.thinkingLevel ?? 'medium')
      setConfigured(cfg)
    })()
  }, [])

  // Wipe the apiKey input when the user switches provider — otherwise a
  // key typed for provider A would silently save under provider B at
  // the next blur. Reset the reveal toggle too so the next entry starts
  // masked. The first effect run on mount is skipped via a ref so the
  // initial provider value (loaded from disk) doesn't clear an existing
  // typed key (there is none on mount, but the no-op is honest).
  const isFirstProviderEffect = useRef(true)
  useEffect(() => {
    if (isFirstProviderEffect.current) {
      isFirstProviderEffect.current = false
      return
    }
    setApiKey('')
    setRevealed(false)
  }, [provider])

  // ---- Auto-save (settings.json, no keychain) -----------------------------
  // Watches the four persisted fields; saves 1.5s after the user stops
  // editing. apiKey lives outside this pipeline because writing
  // half-typed keys to the OS keychain is a footgun.
  const settingsForSave = useMemo(
    () => ({ provider, builtinModel, custom, thinkingLevel }),
    [provider, builtinModel, custom, thinkingLevel],
  )

  // settingsDirty = persisted snapshot diverges from current form. Used
  // both as the auto-save trigger and as a gate on the unmount-flush
  // (only flush if we owe a save).
  const settingsDirty = useMemo(() => {
    if (!settings) return false
    if (provider !== settings.ai.provider) return true
    if (thinkingLevel !== settings.ai.thinkingLevel) return true
    for (const k of ['anthropic', 'openai', 'google'] as const) {
      if (builtinModel[k] !== settings.ai.builtinModel[k]) return true
    }
    for (const k of ['custom-openai', 'custom-anthropic', 'custom-responses'] as const) {
      if (
        custom[k]?.baseUrl !== settings.ai.custom[k]?.baseUrl ||
        custom[k]?.model !== settings.ai.custom[k]?.model
      ) {
        return true
      }
    }
    return false
  }, [settings, provider, builtinModel, custom, thinkingLevel])

  // Persisted-snapshot ref so the unmount flush reads the latest one
  // without re-binding the effect on every save round-trip.
  const persistedRef = useRef(settings)
  persistedRef.current = settings
  const settingsForSaveRef = useRef(settingsForSave)
  settingsForSaveRef.current = settingsForSave

  // Save flow extracted so both the debounced effect and the
  // unmount-flush can call it. Returns the saved Settings on success
  // so the caller can update its snapshot. useCallback keeps the
  // reference stable across renders so effects depending on it stay
  // honest with deps lists.
  const flushSave = useCallback(
    async (values: typeof settingsForSave): Promise<Settings | null> => {
      try {
        const saved = await window.deck.settings.save({
          ai: {
            provider: values.provider,
            builtinModel: { ...values.builtinModel } as Settings['ai']['builtinModel'],
            custom: { ...values.custom } as Settings['ai']['custom'],
            thinkingLevel: values.thinkingLevel,
          },
        })
        return saved
      } catch (e) {
        setStatus({ kind: 'err', msg: e instanceof Error ? e.message : String(e) })
        return null
      }
    },
    [],
  )

  // Debounced auto-save: any settings change schedules a write 1.5s
  // out; subsequent edits cancel the pending timer and reschedule.
  useEffect(() => {
    if (!settings) return
    if (!settingsDirty) return
    setStatus({ kind: 'saving' })
    const timer = setTimeout(async () => {
      const saved = await flushSave(settingsForSave)
      if (saved) {
        setSettings(saved)
        setStatus({ kind: 'saved' })
      }
    }, SAVE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsDirty, settingsForSave, settings])

  // Saved-flash auto-fade: leave 'saved' onscreen briefly so the user
  // sees the confirmation, then return to idle so it doesn't linger.
  useEffect(() => {
    if (status.kind !== 'saved') return
    const timer = setTimeout(() => setStatus({ kind: 'idle' }), SAVED_FLASH_MS)
    return () => clearTimeout(timer)
  }, [status])

  // Unmount flush: if the user closes Settings during the debounce
  // window, fire the save synchronously so the edit doesn't get lost.
  // Fire-and-forget — the modal is gone, no UI to surface failures.
  useEffect(() => {
    return () => {
      const persisted = persistedRef.current
      const cur = settingsForSaveRef.current
      if (!persisted) return
      const same =
        cur.provider === persisted.ai.provider &&
        cur.thinkingLevel === persisted.ai.thinkingLevel &&
        (['anthropic', 'openai', 'google'] as const).every(
          (k) => cur.builtinModel[k] === persisted.ai.builtinModel[k],
        ) &&
        (['custom-openai', 'custom-anthropic', 'custom-responses'] as const).every(
          (k) =>
            cur.custom[k]?.baseUrl === persisted.ai.custom[k]?.baseUrl &&
            cur.custom[k]?.model === persisted.ai.custom[k]?.model,
        )
      if (same) return
      void flushSave(cur)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- apiKey blur → keychain ---------------------------------------------
  // Writing the key to the OS keychain on every keystroke is wrong:
  // partial keys get persisted, possibly conflicting across providers
  // mid-edit. Blur is the natural commit point — the user has clearly
  // finished entering the key. After commit we clear the input (the
  // value lives in the keychain now) and flip `configured` so the hint
  // and trailing icon update immediately.
  async function commitApiKey() {
    const trimmed = apiKey.trim()
    if (!trimmed) return
    try {
      await window.deck.settings.setApiKey(provider, trimmed)
      setConfigured((c) => ({ ...c, [provider]: true }))
      setApiKey('')
      setRevealed(false)
    } catch (e) {
      setStatus({ kind: 'err', msg: e instanceof Error ? e.message : String(e) })
    }
  }

  // ---- Auto-ping (validate config end-to-end) -----------------------------
  // Triggers 1s after a settled config (provider/model/baseUrl) change
  // OR a save lands OR commitApiKey writes a new keychain entry.
  //
  // Deliberately does NOT use the user's in-progress `apiKey` value:
  // pinging on every keystroke would spam failures with partial keys.
  // The blur-to-commit path puts the key in keychain and clears the
  // input, which then re-triggers this effect — at that point the ping
  // uses the freshly saved key.
  //
  // Skipped when no key is configured for the active provider (would
  // produce a no-key error every time the user opens Settings without
  // one) or while auto-save is pending (wait for new settings to land
  // first so the ping actually exercises them).
  const pingPayload = useMemo(
    () => ({
      provider,
      modelValue: provider.startsWith('custom-')
        ? custom[provider]?.model ?? ''
        : builtinModel[provider] ?? '',
      customForProvider: provider.startsWith('custom-') ? custom[provider] : undefined,
    }),
    [provider, builtinModel, custom],
  )
  useEffect(() => {
    if (!settings) return
    if (!configured[provider]) return
    if (status.kind === 'saving') return
    // While the user is mid-typing in apiKey, defer ping. commitApiKey
    // clears apiKey on success, so this gate releases automatically.
    if (apiKey.length > 0) return
    const timer = setTimeout(async () => {
      setStatus({ kind: 'pinging' })
      try {
        const r = await window.deck.settings.ping({
          provider: pingPayload.provider,
          model: pingPayload.modelValue || undefined,
          custom: pingPayload.customForProvider
            ? { [pingPayload.provider]: pingPayload.customForProvider }
            : undefined,
        })
        if (r.ok) {
          setStatus({
            kind: 'ok',
            msg: t('settings.status.pingOk', {
              provider: r.provider ?? '',
              model: r.model ?? '',
              text: r.text || t('chat.status.empty'),
            }),
          })
        } else {
          setStatus({ kind: 'err', msg: r.error ?? t('settings.status.pingFailed') })
        }
      } catch (e) {
        setStatus({ kind: 'err', msg: e instanceof Error ? e.message : String(e) })
      }
    }, PING_DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, configured, provider, pingPayload, apiKey === '', status.kind === 'saving'])

  // ---- clear-saved-key path ------------------------------------------------
  async function deleteSavedKey() {
    try {
      await window.deck.settings.clearApiKey(provider)
      setConfigured((c) => ({ ...c, [provider]: false }))
      setStatus({
        kind: 'ok',
        msg: t('settings.status.clearedKey', { provider: providerLabel(provider) }),
      })
    } catch (e) {
      setStatus({ kind: 'err', msg: e instanceof Error ? e.message : String(e) })
    }
  }

  // Hooks above; conditional render below. (Keep this guard AFTER all
  // hook calls — see history of React error #310 for context.)
  if (!settings) return null

  const isCustom = provider.startsWith('custom-')
  function providerLabel(p: ProviderId) {
    return BUILTIN_LABELS[p] ?? t(CUSTOM_LABEL_KEY[p] as any)
  }
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

  return (
    <section className="flex flex-col gap-4">
      <Field label={t('settings.provider')}>
        <Select
          value={provider}
          onChange={(v) => setProvider(v as ProviderId)}
          ariaLabel={t('settings.provider')}
          groups={[
            {
              label: t('settings.provider.builtin'),
              items: BUILTIN_IDS.map((p) => ({ value: p, label: providerLabel(p) })),
            },
            {
              label: t('settings.provider.custom'),
              items: CUSTOM_IDS.map((p) => ({ value: p, label: providerLabel(p) })),
            },
          ]}
        />
      </Field>

      {isCustom && (
        <Field label={t('settings.baseUrl')} hint={baseUrlHint}>
          <TextInput
            value={baseUrlValue}
            onChange={(e) =>
              setCustom((c) => ({
                ...c,
                [provider]: { ...c[provider], baseUrl: e.target.value },
              }))
            }
            placeholder="https://…/v1"
          />
        </Field>
      )}

      <Field label={t('settings.model')} hint={modelHint}>
        <TextInput
          value={modelValue}
          onChange={(e) => {
            const v = e.target.value
            if (isCustom) setCustom((c) => ({ ...c, [provider]: { ...c[provider], model: v } }))
            else setBuiltinModel((m) => ({ ...m, [provider]: v }))
          }}
          placeholder={isCustom ? t('settings.model.placeholder.custom') : recommended}
        />
      </Field>

      <Field label={t('settings.thinking')} hint={t('settings.thinking.hint')}>
        <Segmented
          ariaLabel={t('settings.thinking')}
          value={thinkingLevel}
          onChange={(v) => setThinkingLevel(v as ThinkingLevel)}
          options={[
            { value: 'off', label: t('settings.thinking.off') },
            { value: 'minimal', label: t('settings.thinking.minimal') },
            { value: 'low', label: t('settings.thinking.low') },
            { value: 'medium', label: t('settings.thinking.medium') },
            { value: 'high', label: t('settings.thinking.high') },
            { value: 'xhigh', label: t('settings.thinking.xhigh') },
          ]}
        />
      </Field>

      <Field label={t('settings.apiKey')} hint={keyHint}>
        <TextInput
          mono
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          onBlur={() => void commitApiKey()}
          type={revealed ? 'text' : 'password'}
          placeholder={
            configured[provider]
              ? t('settings.apiKey.placeholder.saved')
              : t('settings.apiKey.placeholder.empty')
          }
          trailing={
            <ApiKeyTrailing
              hasInput={apiKey.length > 0}
              hasSavedKey={!!configured[provider]}
              revealed={revealed}
              onClearInput={() => {
                setApiKey('')
                setRevealed(false)
              }}
              onDeleteSaved={() => {
                const ok = window.confirm(
                  t('settings.apiKey.deleteConfirm', { provider: providerLabel(provider) }),
                )
                if (ok) void deleteSavedKey()
              }}
              onToggleReveal={() => setRevealed((v) => !v)}
            />
          }
        />
      </Field>

      <StatusRow status={status} />
    </section>
  )
}

// Trailing icon cluster lives inside the apiKey TextInput's right edge.
// X / Trash2 / Eye are mutually constrained by input + keychain state.
function ApiKeyTrailing({
  hasInput,
  hasSavedKey,
  revealed,
  onClearInput,
  onDeleteSaved,
  onToggleReveal,
}: {
  hasInput: boolean
  hasSavedKey: boolean
  revealed: boolean
  onClearInput: () => void
  onDeleteSaved: () => void
  onToggleReveal: () => void
}) {
  const t = useI18n((s) => s.t)
  return (
    <>
      {/*
        Two-mode "destroy" affordance:
          - input has unsaved text → X clears the input (cheap undo)
          - input empty AND keychain has a saved key → Trash with
            native confirm clears the keychain entry
          - else: hidden so the eye toggle anchors at the right edge
            instead of jumping when the input clears.
      */}
      {hasInput ? (
        <Tooltip content={t('settings.apiKey.clearInput')}>
          <IconButton
            size="sm"
            onClick={onClearInput}
            // Prevent input blur on icon click — clicking X should
            // wipe the field, not commit the partial value to keychain.
            onMouseDown={(e) => e.preventDefault()}
            aria-label={t('settings.apiKey.clearInput')}
          >
            <X />
          </IconButton>
        </Tooltip>
      ) : hasSavedKey ? (
        <Tooltip content={t('settings.apiKey.deleteSaved')}>
          <IconButton
            size="sm"
            onClick={onDeleteSaved}
            onMouseDown={(e) => e.preventDefault()}
            aria-label={t('settings.apiKey.deleteSaved')}
            className="text-danger hover:text-danger"
          >
            <Trash2 />
          </IconButton>
        </Tooltip>
      ) : null}
      <Tooltip content={revealed ? t('settings.toggleReveal.hide') : t('settings.toggleReveal.show')}>
        <IconButton
          size="sm"
          onClick={onToggleReveal}
          // Keep blur from firing on the eye toggle either; the user
          // hasn't finished entering the key yet.
          onMouseDown={(e) => e.preventDefault()}
          aria-label={t('aria.toggleKey')}
          data-revealed={revealed}
        >
          {revealed ? <EyeOff /> : <Eye />}
        </IconButton>
      </Tooltip>
    </>
  )
}

function StatusRow({ status }: { status: Status }) {
  const t = useI18n((s) => s.t)
  let text = ''
  let kind: '' | 'ok' | 'err' | 'pending' = ''
  switch (status.kind) {
    case 'saving':
      text = t('settings.status.saving')
      kind = 'pending'
      break
    case 'saved':
      text = t('settings.status.saved')
      kind = 'ok'
      break
    case 'pinging':
      text = t('settings.status.pinging')
      kind = 'pending'
      break
    case 'ok':
      text = status.msg
      kind = 'ok'
      break
    case 'err':
      text = status.msg
      kind = 'err'
      break
  }
  return (
    <div className="mt-1 flex min-h-5 items-center">
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-[12px] text-ink-3',
          kind === 'ok' && 'text-success',
          kind === 'err' && 'text-danger',
        )}
      >
        {text}
      </span>
    </div>
  )
}

function EncryptionWarning() {
  const t = useI18n((s) => s.t)
  const [available, setAvailable] = useState(true)
  useEffect(() => {
    void window.deck.settings.encryptionAvailable().then((v) => setAvailable(!!v))
  }, [])
  if (available) return null
  return (
    <div className="rounded-lg bg-[rgb(var(--color-warning-rgb)/0.12)] p-3.5 text-[12px] leading-snug text-warning">
      {t('settings.encryption.unavailable')}
    </div>
  )
}
