import { ExternalLink, Globe } from 'lucide-react'
import { useI18n } from '#/renderer/stores/i18n.ts'
import { Section } from '#/renderer/components/SettingsOverlay/bits.tsx'
import iconUrl from '#/renderer/assets/icon.png'

const REPO_URL = 'https://github.com/nano-props/deck-app'
const WEBSITE_URL = 'https://nano-props.github.io/deck-app/'

export function AboutTab() {
  const t = useI18n((s) => s.t)

  const open = (url: string) => window.deck.openExternal?.(url)

  const commit = __BUILD_INFO__.commit
  const electron = __BUILD_INFO__.electron

  return (
    <div className="flex flex-col gap-5">
      {/*
        Header: icon + name + version on one row, sitting flush-left so
        About reads in the same rhythm as Appearance / AI rather than a
        center-stage hero. The description sits beneath as quiet body
        text — same visual weight as a Field hint elsewhere.
      */}
      <header className="flex items-center gap-4">
        <img src={iconUrl} alt="" aria-hidden draggable={false} className="size-12 select-none" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="m-0 text-[15px] font-semibold leading-tight text-ink">Deck App</h2>
          <p className="m-0 text-[12px] leading-snug text-ink-3">{t('settings.about.description')}</p>
        </div>
      </header>

      <Section title={t('settings.about.section.build')}>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-[12px]">
          <MetaRow label={t('settings.about.version')} value={__APP_VERSION__} mono />
          {electron && <MetaRow label={t('settings.about.electron')} value={electron} mono />}
          {commit && <MetaRow label={t('settings.about.commit')} value={commit} mono />}
          <MetaRow label={t('settings.about.license')} value={t('settings.about.licenseName')} />
        </dl>
      </Section>

      <Section title={t('settings.about.section.resources')}>
        <ul className="flex flex-col gap-1">
          <ResourceRow
            label={t('settings.about.website')}
            icon={<Globe className="size-3.5" aria-hidden />}
            onClick={() => open(WEBSITE_URL)}
          />
          <ResourceRow label="GitHub" icon={<GithubIcon />} onClick={() => open(REPO_URL)} />
        </ul>
      </Section>
    </div>
  )
}

function MetaRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt className="text-ink-3">{label}</dt>
      <dd className={`m-0 truncate ${mono ? 'font-mono' : ''} text-ink-2`}>{value}</dd>
    </>
  )
}

function ResourceRow({ label, icon, onClick }: { label: string; icon: React.ReactNode; onClick: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="group flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-[13px] text-ink transition-colors hover:bg-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 cursor-pointer"
      >
        <span className="inline-flex items-center gap-2.5 text-ink">
          <span className="text-ink-3 group-hover:text-ink-2">{icon}</span>
          {label}
        </span>
        <ExternalLink className="size-3.5 text-ink-4 group-hover:text-ink-3" aria-hidden />
      </button>
    </li>
  )
}

// Official GitHub mark (simplified path). lucide-react removed brand icons,
// so we inline this rather than pull in a dedicated brand-icons package.
function GithubIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5" fill="currentColor" aria-hidden>
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2.17c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.27-1.69-1.27-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.76 2.69 1.25 3.35.96.1-.74.4-1.25.72-1.54-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.78 0c2.21-1.49 3.18-1.18 3.18-1.18.62 1.58.23 2.75.11 3.04.74.81 1.18 1.84 1.18 3.1 0 4.43-2.7 5.4-5.27 5.69.41.36.78 1.06.78 2.13v3.16c0 .31.21.66.8.55C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  )
}
