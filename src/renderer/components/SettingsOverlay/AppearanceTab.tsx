import { useI18n } from '#/renderer/stores/i18n.ts'
import { useTheme, type ThemePref } from '#/renderer/stores/theme.ts'
import { Field, Segmented } from '#/renderer/components/SettingsOverlay/bits.tsx'
import { LANG_OPTIONS } from '#/renderer/components/SettingsOverlay/providers.ts'

export function AppearanceTab() {
  const t = useI18n((s) => s.t)
  const themePref = useTheme((s) => s.pref)
  const setTheme = useTheme((s) => s.setPref)
  const langPref = useI18n((s) => s.pref)
  const setLangPref = useI18n((s) => s.setPref)

  return (
    <section className="flex flex-col gap-4">
      <Field label={t('settings.theme')} hint={t('settings.theme.hint')}>
        <Segmented
          value={themePref}
          onChange={(v) => void setTheme(v as ThemePref)}
          ariaLabel={t('aria.themeRadiogroup')}
          options={[
            { value: 'auto', label: t('settings.theme.auto') },
            { value: 'light', label: t('settings.theme.light') },
            { value: 'dark', label: t('settings.theme.dark') },
          ]}
        />
      </Field>

      <Field label={t('settings.language')} hint={t('settings.language.hint')}>
        <Segmented
          value={langPref}
          onChange={(v) => void setLangPref(v as Parameters<typeof setLangPref>[0])}
          ariaLabel={t('aria.langRadiogroup')}
          options={LANG_OPTIONS.map((o) => ({
            value: o.value,
            label: o.label === '__auto' ? t('settings.language.auto') : o.label,
          }))}
        />
      </Field>
    </section>
  )
}
