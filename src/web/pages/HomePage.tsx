// HomePage — assembles topbar, the eight sections, and the footer.
//
// `body.home` (set as a literal class in `index.html`) gates all of
// `home.css`'s scoped rules — so the marketing styles never paint on
// the player route, which uses a separate HTML entry. The class is
// stamped in the HTML rather than added in an effect so first paint
// already has the homepage layout (no FOUC of unstyled <header>).

import '#/web/home/home.css'
import { Topbar } from '#/web/home/Topbar.tsx'
import { Footer } from '#/web/home/Footer.tsx'
import {
  HeroSection,
  MetaSection,
  WhatIsSection,
  HowSection,
  SkillSection,
  SecuritySection,
  CompareSection,
  EndCtaSection,
} from '#/web/home/sections.tsx'

export function HomePage() {
  return (
    <>
      <Topbar />
      <HeroSection />
      <MetaSection />
      <WhatIsSection />
      <HowSection />
      <SkillSection />
      <SecuritySection />
      <CompareSection />
      <EndCtaSection />
      <Footer />
    </>
  )
}
