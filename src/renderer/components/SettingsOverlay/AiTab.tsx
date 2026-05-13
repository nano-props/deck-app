import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '#/renderer/stores/i18n.ts'
import { Select } from '#/renderer/components/ui/Select.tsx'
import { TextInput } from '#/renderer/components/ui/TextInput.tsx'
import { registerFlusher } from '#/renderer/lib/flush-registry.ts'
import { useLatestRef } from '#/renderer/hooks/useLatestRef.ts'
import type { ThinkingLevel } from '@earendil-works/pi-agent-core'
import type { ProviderId } from '#/main/secrets.ts'
import type { Settings } from '#/main/settings.ts'
import { Field, Section, Segmented } from '#/renderer/components/SettingsOverlay/bits.tsx'
import {
  BASEURL_HINT_KEY,
  BUILTIN_IDS,
  BUILTIN_LABELS,
  CLI_IDS,
  CUSTOM_IDS,
  CUSTOM_LABEL_KEY,
  RECOMMENDED_MODEL,
} from '#/renderer/components/SettingsOverlay/providers.ts'
import { AiStatusChip, AiStatusMessage, type AiStatus } from '#/renderer/components/SettingsOverlay/AiStatusRow.tsx'
import { AiKeyTrailing } from '#/renderer/components/SettingsOverlay/AiKeyTrailing.tsx'

export function AiTab() {
  return (
    <div className="flex flex-col gap-5">
      <AiGroup />
      <EncryptionWarning />
    </div>
  )
}

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
  const [status, setStatus] = useState<AiStatus>({ kind: 'idle' })

  // ---- Initial load --------------------------------------------------------
  useEffect(() => {
    void (async () => {
      // Run both reads in parallel — they're independent. Sequential
      // await flickers `keyHint` blank before the keychain check
      // resolves and reveals "Saved for X".
      const [s, cfg] = await Promise.all([window.deck.settings.load(), window.deck.settings.listConfiguredProviders()])
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
      if (custom[k]?.baseUrl !== settings.ai.custom[k]?.baseUrl || custom[k]?.model !== settings.ai.custom[k]?.model) {
        return true
      }
    }
    return false
  }, [settings, provider, builtinModel, custom, thinkingLevel])

  // Mount-only flusher reads form state at teardown — refs let us
  // dodge the closure-staleness trap without re-binding the effect on
  // every render.
  const persistedRef = useLatestRef(settings)
  const settingsForSaveRef = useLatestRef(settingsForSave)

  // Save flow extracted so both the debounced effect and the
  // unmount-flush can call it. Returns the saved Settings on success
  // so the caller can update its snapshot. useCallback keeps the
  // reference stable across renders so effects depending on it stay
  // honest with deps lists.
  const flushSave = useCallback(async (values: typeof settingsForSave): Promise<Settings | null> => {
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
  }, [])

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

  // Saved-flash / cleared-flash auto-fade: leave transient success onscreen
  // briefly so the user sees the confirmation, then return to idle.
  useEffect(() => {
    if (status.kind !== 'saved' && status.kind !== 'cleared') return
    const timer = setTimeout(() => setStatus({ kind: 'idle' }), SAVED_FLASH_MS)
    return () => clearTimeout(timer)
  }, [status])

  // Track unflushed apiKey so the unmount path can commit it. blur
  // commits normally, but if the user closes Settings (Esc / X / click
  // outside) before blur fires, the keystrokes would otherwise be lost.
  const apiKeyRef = useLatestRef(apiKey)
  const providerRef = useLatestRef(provider)

  // Pending-edit flush: commit any debounced settings.json save and
  // un-blurred apiKey before the window goes away. Routed through
  // `lib/flush-registry.ts` rather than a useEffect cleanup — see that
  // file for why cleanups can't carry async IPC reliably.
  //
  // Calls the IPC directly instead of going through `flushSave` — the
  // latter swallows errors into setStatus (right behaviour for the
  // debounced auto-save, where we want a non-blocking inline error
  // banner) but wrong here: the registry needs to see rejections so
  // main can warn the user before tearing down the window.
  useEffect(() => {
    return registerFlusher(async () => {
      const persisted = persistedRef.current
      const cur = settingsForSaveRef.current
      if (persisted) {
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
        if (!same) {
          await window.deck.settings.save({
            ai: {
              provider: cur.provider,
              builtinModel: { ...cur.builtinModel } as Settings['ai']['builtinModel'],
              custom: { ...cur.custom } as Settings['ai']['custom'],
              thinkingLevel: cur.thinkingLevel,
            },
          })
        }
      }
      const trimmedKey = apiKeyRef.current.trim()
      if (trimmedKey) {
        await window.deck.settings.setApiKey(providerRef.current, trimmedKey)
      }
    })
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
      modelValue: provider.startsWith('custom-') ? (custom[provider]?.model ?? '') : (builtinModel[provider] ?? ''),
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
    // Stale-result guard: a ping that's still in flight when the user
    // changes provider/model would otherwise resolve into the new
    // form's status display, briefly showing "ping ok for anthropic"
    // while the form already reads openai. cleanup flips this so the
    // resolved handler bails before calling setStatus.
    let cancelled = false
    const timer = setTimeout(async () => {
      if (cancelled) return
      setStatus({ kind: 'pinging' })
      try {
        const r = await window.deck.settings.ping({
          provider: pingPayload.provider,
          model: pingPayload.modelValue || undefined,
          custom: pingPayload.customForProvider ? { [pingPayload.provider]: pingPayload.customForProvider } : undefined,
        })
        if (cancelled) return
        if (r.ok) {
          setStatus({ kind: 'idle' })
        } else {
          setStatus({ kind: 'err', msg: r.error ?? t('settings.status.pingFailed') })
        }
      } catch (e) {
        if (cancelled) return
        setStatus({ kind: 'err', msg: e instanceof Error ? e.message : String(e) })
      }
    }, PING_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, configured, provider, pingPayload, apiKey === '', status.kind === 'saving'])

  // ---- clear-saved-key path ------------------------------------------------
  async function deleteSavedKey() {
    try {
      await window.deck.settings.clearApiKey(provider)
      setConfigured((c) => ({ ...c, [provider]: false }))
      setStatus({
        kind: 'cleared',
        msg: t('settings.status.clearedKey', { provider: providerLabel(provider) }),
      })
    } catch (e) {
      setStatus({ kind: 'err', msg: e instanceof Error ? e.message : String(e) })
    }
  }

  // Hooks above; conditional render below. (Keep this guard AFTER all
  // hook calls — see history of React error #310 for context.)
  if (!settings) return null

  const isCli = provider === 'claude-cli'
  const isCustom = !isCli && provider.startsWith('custom-')
  function providerLabel(p: ProviderId) {
    return BUILTIN_LABELS[p] ?? t(CUSTOM_LABEL_KEY[p] as any)
  }
  const modelValue = isCustom ? (custom[provider]?.model ?? '') : (builtinModel[provider] ?? '')
  const recommended = RECOMMENDED_MODEL[provider] ?? ''
  const modelHint = isCustom
    ? ''
    : recommended
      ? t('settings.model.hint.builtinRecommended', { model: recommended })
      : t('settings.model.hint.builtin')
  const baseUrlValue = isCustom ? (custom[provider]?.baseUrl ?? '') : ''
  const baseUrlHintKey = isCustom ? BASEURL_HINT_KEY[provider] : undefined
  const baseUrlHint = baseUrlHintKey ? t(baseUrlHintKey as any) : ''

  return (
    <div className="flex flex-col gap-5">
      <Section title={t('settings.ai.section.connection')}>
        <Field label={t('settings.provider')}>
          <Select
            value={provider}
            onChange={(v) => setProvider(v as ProviderId)}
            ariaLabel={t('settings.provider')}
            groups={[
              {
                label: t('settings.provider.local'),
                items: CLI_IDS.map((p) => ({ value: p, label: providerLabel(p) })),
              },
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

        {isCli && <ClaudeCliStatusCard />}

        {!isCli && isCustom && (
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

        {!isCli && (
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
        )}
      </Section>

      {!isCli && (
      <Section title={t('settings.ai.section.credentials')}>
        {/*
          Credentials live in a tinted card so the API key + its status
          chip + the long-form ping result read as one unit. The chip
          rides in the top-right corner, summarising the steady state
          (Connected / Not connected) and the transient pipeline events
          (Saving / Pinging / Saved / Error) in the same affordance.
        */}
        <div className="flex flex-col gap-2.5 rounded-lg border border-line bg-bg-deep p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[12px] font-semibold text-ink-2">{t('settings.apiKey')}</span>
            <AiStatusChip status={status} hasKey={!!configured[provider]} />
          </div>
          <TextInput
            mono
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            onBlur={() => void commitApiKey()}
            type={revealed ? 'text' : 'password'}
            placeholder={
              configured[provider] ? t('settings.apiKey.placeholder.saved') : t('settings.apiKey.placeholder.empty')
            }
            trailing={
              <AiKeyTrailing
                hasInput={apiKey.length > 0}
                hasSavedKey={!!configured[provider]}
                revealed={revealed}
                onClearInput={() => {
                  setApiKey('')
                  setRevealed(false)
                }}
                onDeleteSaved={() => {
                  const ok = window.confirm(t('settings.apiKey.deleteConfirm', { provider: providerLabel(provider) }))
                  if (ok) void deleteSavedKey()
                }}
                onToggleReveal={() => setRevealed((v) => !v)}
              />
            }
          />
          <AiStatusMessage status={status} />
        </div>
      </Section>
      )}

      {!isCli && (
      <Section title={t('settings.ai.section.behavior')}>
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
      </Section>
      )}
    </div>
  )
}

/**
 * CLI provider status panel. Runs detection on mount and lets the user
 * re-check after they install the binary. We deliberately don't make
 * this look like the API-key card — the affordance is different (no
 * input, no save), and conflating them would imply Claude Code needs
 * an API key, which it doesn't.
 */
function ClaudeCliStatusCard() {
  const t = useI18n((s) => s.t)
  const [state, setState] = useState<{ phase: 'checking' } | { phase: 'done'; found: boolean; version?: string; error?: string }>(
    { phase: 'checking' },
  )

  const detect = useCallback(async (refresh: boolean) => {
    setState({ phase: 'checking' })
    const r = await window.deck.settings.detectClaudeCli(refresh)
    setState({ phase: 'done', found: !!r.found, version: r.version, error: r.error })
  }, [])

  useEffect(() => {
    void detect(false)
  }, [detect])

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-line bg-bg-deep p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12px] font-semibold text-ink-2">{t('settings.cli.binaryStatus')}</span>
        <button
          type="button"
          className="text-[11px] text-ink-2 underline-offset-2 hover:underline"
          onClick={() => void detect(true)}
        >
          {t('settings.cli.recheck')}
        </button>
      </div>
      {state.phase === 'checking' && (
        <div className="text-[12px] text-ink-2">{t('settings.cli.checking')}</div>
      )}
      {state.phase === 'done' && state.found && (
        <div className="text-[12px] text-ink">
          {t('settings.cli.found', { version: state.version ?? '' })}
        </div>
      )}
      {state.phase === 'done' && !state.found && (
        <div className="flex flex-col gap-1.5">
          <div className="text-[12px] text-warning">
            {state.error || t('settings.cli.notFound')}
          </div>
          <div className="text-[11px] text-ink-2">
            {t('settings.cli.installHint')}
          </div>
        </div>
      )}
      <div className="whitespace-pre-line text-[11px] leading-snug text-ink-2">
        {t('settings.cli.description')}
      </div>
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
