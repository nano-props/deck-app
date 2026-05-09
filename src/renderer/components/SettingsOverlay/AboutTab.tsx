import { Globe } from 'lucide-react'
import { useI18n } from '#/renderer/stores/i18n.ts'
import { Button } from '#/renderer/components/ui/Button.tsx'
import iconUrl from '#/renderer/assets/icon.png'

const REPO_URL = 'https://github.com/nano-props/deck-app'
const WEBSITE_URL = 'https://nano-props.github.io/deck-app/'

export function AboutTab() {
  const t = useI18n((s) => s.t)

  const open = (url: string) => window.deck.openExternal?.(url)

  const commit = __BUILD_INFO__.commit
  const electron = __BUILD_INFO__.electron

  return (
    <section className="flex flex-col items-center gap-5 text-center">
      <img
        src={iconUrl}
        alt=""
        aria-hidden
        draggable={false}
        className="h-20 w-20 select-none"
      />

      <div className="flex flex-col items-center gap-1">
        <h2 className="text-[20px] font-semibold leading-tight text-ink">Deck App</h2>
        <p className="m-0 max-w-[360px] text-[12px] leading-snug text-ink-3">
          {t('settings.about.description')}
        </p>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-left text-[12px]">
        <MetaRow label={t('settings.about.version')} value={__APP_VERSION__} />
        {electron && <MetaRow label={t('settings.about.electron')} value={electron} />}
        {commit && <MetaRow label={t('settings.about.commit')} value={commit} />}
        <MetaRow label={t('settings.about.license')} value={t('settings.about.licenseName')} />
      </dl>

      <div className="flex gap-2">
        <Button variant="default" size="sm" onClick={() => open(WEBSITE_URL)} className="gap-1.5">
          <Globe className="h-3.5 w-3.5" />
          {t('settings.about.website')}
        </Button>
        <Button variant="default" size="sm" onClick={() => open(REPO_URL)} className="gap-1.5">
          <GithubIcon />
          GitHub
        </Button>
      </div>
    </section>
  )
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-ink-3">{label}</dt>
      <dd className="m-0 font-mono text-[12px] text-ink-2">{value}</dd>
    </>
  )
}

// Official GitHub mark (simplified path). lucide-react removed brand icons,
// so we inline this rather than pull in a dedicated brand-icons package.
function GithubIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2.17c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.27-1.69-1.27-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.76 2.69 1.25 3.35.96.1-.74.4-1.25.72-1.54-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.78 0c2.21-1.49 3.18-1.18 3.18-1.18.62 1.58.23 2.75.11 3.04.74.81 1.18 1.84 1.18 3.1 0 4.43-2.7 5.4-5.27 5.69.41.36.78 1.06.78 2.13v3.16c0 .31.21.66.8.55C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  )
}
