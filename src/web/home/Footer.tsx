import { useI18n, asHtml } from '#/web/lib/i18n.ts'

export function Footer() {
  const t = useI18n((s) => s.t)
  return (
    <footer>
      <div className="wrap">
        <div className="brand">
          <span>Deck</span>
        </div>
        <div className="links">
          <a href="#whatis" dangerouslySetInnerHTML={asHtml(t('navWhat'))} />
          <a href="#how" dangerouslySetInnerHTML={asHtml(t('footHow'))} />
          <a href="#skill" dangerouslySetInnerHTML={asHtml(t('footSkill'))} />
          <a href="#security" dangerouslySetInnerHTML={asHtml(t('footSafe'))} />
          <a href="player/" dangerouslySetInnerHTML={asHtml(t('navPlayer'))} />
          <a
            href="https://github.com/nano-props/deck-app"
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
        </div>
      </div>
    </footer>
  )
}
