import type { ProviderId } from '#/main/secrets.ts'

export const BUILTIN_IDS: ProviderId[] = ['anthropic', 'openai', 'google']
export const CUSTOM_IDS: ProviderId[] = ['custom-openai', 'custom-anthropic', 'custom-responses']

export const BUILTIN_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
}

export const CUSTOM_LABEL_KEY: Record<string, string> = {
  'custom-openai': 'settings.provider.label.customOpenai',
  'custom-anthropic': 'settings.provider.label.customAnthropic',
  'custom-responses': 'settings.provider.label.customResponses',
}

export const BASEURL_HINT_KEY: Record<string, string> = {
  'custom-anthropic': 'settings.baseUrl.hint.customAnthropic',
}

export const RECOMMENDED_MODEL: Record<string, string> = {
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
