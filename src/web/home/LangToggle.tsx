// Two-button segmented control for language pick. Order matches
// vanilla: 中 first, EN second. `.on` class drives the highlighted
// state — handled by home.css.

import { useI18n, type Lang } from '#/web/lib/i18n.ts'
import { cn } from '#/web/lib/cn.ts'

export function LangToggle() {
  const lang = useI18n((s) => s.lang)
  const setLang = useI18n((s) => s.setLang)
  return (
    <div className="lang-seg" id="langSeg">
      {(['zh', 'en'] as const).map((l: Lang) => (
        <button
          key={l}
          data-lang={l}
          className={cn(lang === l && 'on')}
          onClick={() => setLang(l)}
        >
          {l === 'zh' ? '中' : 'EN'}
        </button>
      ))}
    </div>
  )
}
