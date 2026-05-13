import type { ProviderId } from '#/main/secrets.ts'

export const BUILTIN_IDS: ProviderId[] = ['anthropic', 'openai', 'google']
export const CUSTOM_IDS: ProviderId[] = ['custom-openai', 'custom-anthropic', 'custom-responses']
export const CLI_IDS: ProviderId[] = ['claude-cli']

// Lookup tables keyed by ProviderId rather than `string` so the
// renderer's value-space stays narrow: a provider id pushed in via
// IPC that hasn't been added to the union won't compile, and TS
// flags missing entries on union expansion. Using `Partial` because
// not every key applies to every provider (BASEURL_HINT_KEY is only
// for one custom variant; RECOMMENDED_MODEL skips CLI providers).
export const BUILTIN_LABELS: Partial<Record<ProviderId, string>> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  'claude-cli': 'Claude Code',
}

export const CUSTOM_LABEL_KEY: Partial<Record<ProviderId, string>> = {
  'custom-openai': 'settings.provider.label.customOpenai',
  'custom-anthropic': 'settings.provider.label.customAnthropic',
  'custom-responses': 'settings.provider.label.customResponses',
}

export const BASEURL_HINT_KEY: Partial<Record<ProviderId, string>> = {
  'custom-anthropic': 'settings.baseUrl.hint.customAnthropic',
}

export const RECOMMENDED_MODEL: Partial<Record<ProviderId, string>> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-5.1',
  google: 'gemini-3-pro-preview',
}

export const LANG_OPTIONS: { value: string; label: string }[] = [
  { value: 'auto', label: '__auto' }, // i18n-resolved at render
  { value: 'en', label: 'English' },
  { value: 'zh', label: '中文' },
  { value: 'ko', label: '한국어' },
]
