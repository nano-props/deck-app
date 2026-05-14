// Top navigation: brand + section anchors + lang/theme + GitHub CTA.
//
// `I18nText` only sets innerHTML — anchors need `href`/`target` props,
// so we read `t` directly here and set the text manually. Same pattern
// as the footer.

import { useI18n, asHtml } from '#/web/lib/i18n.ts'
import { ThemeToggle } from '#/web/home/ThemeToggle.tsx'
import { LangToggle } from '#/web/home/LangToggle.tsx'

export function Topbar() {
  const t = useI18n((s) => s.t)
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <a className="brand" href="#top">
          <span>Deck</span>
        </a>
        <nav className="nav">
          <a href="#whatis" dangerouslySetInnerHTML={asHtml(t('navWhat'))} />
          <a href="#how" dangerouslySetInnerHTML={asHtml(t('navHow'))} />
          <a href="player/" dangerouslySetInnerHTML={asHtml(t('navPlayer'))} />
          <span className="sep" />
          <LangToggle />
          <ThemeToggle />
          <a
            className="cta"
            href="https://github.com/nano-props/deck-app"
            target="_blank"
            rel="noreferrer"
            dangerouslySetInnerHTML={asHtml(t('navCta'))}
          />
        </nav>
      </div>
    </header>
  )
}
