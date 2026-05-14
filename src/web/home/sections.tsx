// Eight homepage sections, in document order. Each one is a leaf —
// pure structural translation of the vanilla `docs/index.html` body
// to JSX, with `<I18nText>` filling in localized HTML and
// `<Reveal>` wrapping the elements that should fade in on scroll.
//
// Class names match the vanilla CSS in `home.css` 1:1 so the visual
// output is byte-identical (modulo React's whitespace handling).

import { I18nText } from '#/web/home/I18nText.tsx'
import { Reveal } from '#/web/home/Reveal.tsx'
import { useI18n, asHtml } from '#/web/lib/i18n.ts'

// ----- Hero -----
export function HeroSection() {
  const t = useI18n((s) => s.t)
  return (
    <section className="hero" id="top">
      <div className="wrap">
        <div className="hero-head">
          <Reveal as="h1" className="">
            <I18nText k="heroTitle" />
          </Reveal>
          <Reveal as="p" className="lead">
            <I18nText k="heroLead" />
          </Reveal>
          <Reveal className="cta-row">
            <a
              className="btn primary has-arrow"
              href="https://github.com/nano-props/deck-app/releases"
              target="_blank"
              rel="noreferrer"
            >
              <span dangerouslySetInnerHTML={asHtml(t('heroCta1'))} />
            </a>
            <a
              className="btn ghost"
              href="#skill"
              dangerouslySetInnerHTML={asHtml(t('heroCta2'))}
            />
          </Reveal>
          <Reveal as="p" className="hero-tip">
            <I18nText k="heroTip" />
          </Reveal>
        </div>

        <Reveal className="hero-visual">
          <div className="titlebar">
            <div className="dots">
              <i />
              <i />
              <i />
            </div>
            <div className="addr mono">
              <b>q3-review.deck</b>
            </div>
          </div>
          <div className="body">
            <div className="slide-mock">
              <I18nText as="h2" k="mockTitle" />
              <I18nText as="p" k="mockBody" />
              <div className="count">
                <span className="mono">01 / 12</span>
                <span className="bar" />
              </div>
            </div>
            <div className="slide-figure" aria-hidden>
              <div className="grid">
                {/* Repeat tile pattern from vanilla — second tile is
                    accent. */}
                <div className="tile">
                  <span className="th" />
                  <span className="ln w1" />
                  <span className="ln w2" />
                </div>
                <div className="tile accent">
                  <span className="th" />
                  <span className="ln w1" />
                  <span className="ln w2" />
                </div>
                <div className="tile">
                  <span className="th" />
                  <span className="ln w1" />
                  <span className="ln w2" />
                </div>
                <div className="tile">
                  <span className="th" />
                  <span className="ln w1" />
                  <span className="ln w2" />
                </div>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  )
}

// ----- Meta strip -----
export function MetaSection() {
  return (
    <section className="meta" style={{ padding: 0 }}>
      <div className="wrap">
        <div className="cell">
          <span className="v stat">1</span>
          <I18nText className="k" k="metaK1" />
        </div>
        <div className="cell">
          <span className="v stat">0</span>
          <I18nText className="k" k="metaK2" />
        </div>
        <div className="cell">
          <span className="v stat">∞</span>
          <I18nText className="k" k="metaK3" />
        </div>
        <div className="cell">
          <span className="v stat">2</span>
          <I18nText className="k" k="metaK4" />
        </div>
      </div>
    </section>
  )
}

// ----- What's a Deck -----
export function WhatIsSection() {
  return (
    <section className="whatis" id="whatis">
      <div className="wrap">
        <div className="inside-grid">
          <Reveal className="manifest-card">
            <div>
              <div className="kicker" style={{ marginBottom: 14 }}>
                <I18nText as="b" k="insideKicker" />
              </div>
              <I18nText as="h3" k="insideTitle" />
              <I18nText as="p" className="sub" k="insideSub" />
            </div>
            <div className="field-list">
              <ManifestRow nameKey="cName1" descKey="cDesc1" req />
              <ManifestRow nameKey="cName2" descKey="cDesc2" req />
              <ManifestRow nameKey="cName3" descKey="cDesc3" req />
              <ManifestRow nameKey="cName4" descKey="cDesc4" />
              <ManifestRow nameKey="cName5" descKey="cDesc5" />
            </div>
            <div className="legend-row">
              <span>
                <span className="legend-dot" />
                <I18nText k="cBasics" />
              </span>
              <span>
                <span className="legend-dot mute" />
                <I18nText k="cExtras" />
              </span>
            </div>
          </Reveal>

          <Reveal className="keys-card">
            <div>
              <div className="kicker" style={{ marginBottom: 14 }}>
                <I18nText as="b" k="keysKicker" />
              </div>
              <I18nText as="h3" k="keysTitle" />
              <I18nText as="p" className="sub" k="keysSub" />
            </div>
            <div className="key-list">
              <KeyRow
                left={
                  <>
                    <kbd>←</kbd> <kbd>→</kbd>
                  </>
                }
                whereKey="k1"
              />
              <KeyRow left={<kbd>Space</kbd>} whereKey="k2" />
              <KeyRow left={<kbd>F11</kbd>} whereKey="k5" />
              <KeyRow left={<kbd>Esc</kbd>} whereKey="k4" />
              <KeyRow leftKey="k6Label" whereKey="k6" />
            </div>
            <div className="key-legend">
              <I18nText k="kLNote" />
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  )
}

function ManifestRow({
  nameKey,
  descKey,
  req,
}: {
  nameKey: 'cName1' | 'cName2' | 'cName3' | 'cName4' | 'cName5'
  descKey: 'cDesc1' | 'cDesc2' | 'cDesc3' | 'cDesc4' | 'cDesc5'
  req?: boolean
}) {
  return (
    <div className="field-row">
      <span className="name">
        <span className={req ? 'req' : 'opt'} />
        <I18nText k={nameKey} />
      </span>
      <I18nText className="desc" k={descKey} />
    </div>
  )
}

import type { DictKey } from '#/web/lib/i18n.ts'
import type { ReactNode } from 'react'

function KeyRow({
  left,
  leftKey,
  whereKey,
}: {
  left?: ReactNode
  leftKey?: DictKey
  whereKey: DictKey
}) {
  return (
    <div className="key-row">
      {leftKey ? <I18nText k={leftKey} /> : <span>{left}</span>}
      <I18nText className="where" k={whereKey} />
    </div>
  )
}

// ----- How it works -----
export function HowSection() {
  return (
    <section className="how" id="how">
      <div className="wrap">
        <Reveal className="kicker">
          <I18nText as="b" k="s3Kicker" /> <I18nText k="s3KickerSub" />
        </Reveal>
        <Reveal as="h2" className="section-h2">
          <I18nText k="s3Title" />
        </Reveal>
        <Reveal as="p" className="how-lead">
          <I18nText k="s3Lead" />
        </Reveal>

        <div className="steps">
          <Reveal className="step">
            <I18nText as="span" className="n" k="s3S1N" />
            <I18nText as="h4" k="s3S1Title" />
            <I18nText as="p" k="s3S1Desc" />
          </Reveal>
          <Reveal className="step">
            <I18nText as="span" className="n" k="s3S2N" />
            <I18nText as="h4" k="s3S2Title" />
            <I18nText as="p" k="s3S2Desc" />
          </Reveal>
          <Reveal className="step">
            <I18nText as="span" className="n" k="s3S3N" />
            <I18nText as="h4" k="s3S3Title" />
            <I18nText as="p" k="s3S3Desc" />
          </Reveal>
        </div>
      </div>
    </section>
  )
}

// ----- Skill bridge -----
export function SkillSection() {
  const t = useI18n((s) => s.t)
  return (
    <section className="skill-bridge" id="skill">
      <Reveal className="wrap">
        <div>
          <I18nText as="span" className="pill" k="skillPill" />
          <I18nText as="h3" k="skillTitle" />
          <I18nText as="p" k="skillDesc" />
          <ul className="skill-paths">
            <li>
              <I18nText as="b" k="skillPath1Name" />
              <I18nText k="skillPath1Desc" />
            </li>
            <li>
              <I18nText as="b" k="skillPath2Name" />
              <I18nText k="skillPath2Desc" />
            </li>
          </ul>
          <div className="cta-row">
            <a
              className="btn primary has-arrow"
              href="https://github.com/nano-props/deck-app/tree/main/skills"
              target="_blank"
              rel="noreferrer"
            >
              <span dangerouslySetInnerHTML={asHtml(t('skillCta1'))} />
            </a>
          </div>
        </div>
        <div className="visual chat-visual" aria-hidden>
          <div className="chat-msg you">
            <I18nText className="chat-who" k="chatWho1" />
            <I18nText className="chat-body" k="chatBody1" />
          </div>
          <div className="chat-msg ai">
            <I18nText className="chat-who" k="chatWho2" />
            <I18nText className="chat-body" k="chatBody2" />
          </div>
          <div className="chat-msg sys">
            <I18nText className="chat-who" k="chatWho3" />
            <I18nText className="chat-body" k="chatBody3" />
          </div>
        </div>
      </Reveal>
    </section>
  )
}

// ----- Security -----
export function SecuritySection() {
  return (
    <section className="security" id="security">
      <div className="wrap">
        <Reveal className="kicker">
          <I18nText as="b" k="s4Kicker" /> <I18nText k="s4KickerSub" />
        </Reveal>
        <Reveal as="h2" className="section-h2" style={{ maxWidth: '24ch' }}>
          <I18nText k="s4Title" />
        </Reveal>

        <Reveal className="sec-list">
          <SecItem mark="1" titleKey="sec1Title" descKey="sec1Desc" />
          <SecItem mark="2" titleKey="sec2Title" descKey="sec2Desc" />
          <SecItem mark="3" titleKey="sec4Title" descKey="sec4Desc" />
        </Reveal>
      </div>
    </section>
  )
}

function SecItem({
  mark,
  titleKey,
  descKey,
}: {
  mark: string
  titleKey: DictKey
  descKey: DictKey
}) {
  return (
    <div className="sec-item">
      <span className="mk">{mark}</span>
      <div>
        <I18nText as="h4" k={titleKey} />
        <I18nText as="p" k={descKey} />
      </div>
    </div>
  )
}

// ----- Compare table -----
export function CompareSection() {
  return (
    <section className="compare" id="compare">
      <div className="wrap">
        <Reveal className="kicker">
          <I18nText as="b" k="s5Kicker" /> <I18nText k="s5KickerSub" />
        </Reveal>
        <Reveal as="h2" className="section-h2">
          <I18nText k="s5Title" />
        </Reveal>

        <Reveal as="table" className="compare-table">
          <thead>
            <tr>
              <th />
              <I18nText as="th" k="cmpH1" />
              <I18nText as="th" k="cmpH2" />
              <I18nText as="th" className="self" k="cmpH4" />
            </tr>
          </thead>
          <tbody>
            <CompareRow rowKey="cmpR1" cells={['yes', 'low', 'yes']} />
            <CompareRow rowKey="cmpR2" cells={['no', 'yes', 'yes']} />
            <CompareRow rowKey="cmpR4" cells={['no', 'no', 'yes']} />
            <CompareRow rowKey="cmpR5" cells={['no', 'yes', 'yes']} />
            <CompareRow rowKey="cmpR6" cells={['no', 'no', 'yes']} />
          </tbody>
        </Reveal>
      </div>
    </section>
  )
}

type CellKind = 'yes' | 'no' | 'low'

function CompareRow({
  rowKey,
  cells,
}: {
  rowKey: DictKey
  cells: [CellKind, CellKind, CellKind]
}) {
  // Mobile reflow: each <td> turns into a labeled card via CSS
  // ::before pulling from data-label. We must materialize that label
  // in the DOM, which means stripping any HTML out of the i18n value
  // first. The vanilla code does the same with `.replace(/<[^>]*>/g, '')`.
  const t = useI18n((s) => s.t)
  const stripHtml = (s: string) => s.replace(/<[^>]*>/g, '')
  const headers: ('cmpH1' | 'cmpH2' | 'cmpH4')[] = ['cmpH1', 'cmpH2', 'cmpH4']

  return (
    <tr>
      <I18nText as="th" k={rowKey} />
      {cells.map((kind, i) => {
        const isSelf = i === 2
        const label = stripHtml(t(headers[i]))
        return (
          <td
            key={i}
            className={isSelf ? 'self' : undefined}
            data-label={label}
          >
            {kind === 'yes' ? (
              <I18nText className="y" k="cmpYes" />
            ) : kind === 'no' ? (
              <I18nText className="n" k="cmpNo" />
            ) : (
              <I18nText k="cmpLow" />
            )}
          </td>
        )
      })}
    </tr>
  )
}

// ----- End CTA -----
export function EndCtaSection() {
  const t = useI18n((s) => s.t)
  return (
    <section className="endcta">
      <div className="wrap">
        <Reveal as="h2">
          <I18nText k="endTitle" />
        </Reveal>
        <Reveal className="cta-row">
          <a
            className="btn primary has-arrow"
            href="https://github.com/nano-props/deck-app/releases"
            target="_blank"
            rel="noreferrer"
          >
            <span dangerouslySetInnerHTML={asHtml(t('endCta1'))} />
          </a>
          <a
            className="btn ghost"
            href="https://github.com/nano-props/deck-app/tree/main/skills"
            target="_blank"
            rel="noreferrer"
            dangerouslySetInnerHTML={asHtml(t('endCta2'))}
          />
        </Reveal>
      </div>
    </section>
  )
}
