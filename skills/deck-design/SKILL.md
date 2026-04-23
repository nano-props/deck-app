---
name: deck-design
description: Shape the visual design of a slide deck for the Deck App — typography, color, motion, spatial composition, aesthetic direction. Use when the user asks to design, style, restyle, redesign, or art-direct a deck, presentation, or slides. Applies on top of `create-deck`, which handles format and packaging.
---

This skill guides the **visual design** of slide decks that avoid generic "AI slop" aesthetics. Implement real working code with exceptional attention to aesthetic details and creative choices.

A **Deck** is a full-screen 16:9 single-page static site opened in the Deck App — navigated by keyboard, used both for live presenting and for reading on one's own afterwards. The user provides deck requirements: topic, audience, chapters, tone. They may include context about the occasion, stage (on-stage talk, async read, internal share) or technical constraints.

**Pair with `create-deck`.** That skill owns the Deck format — `deck.json`, file layout, the CSP sandbox, pagination wiring, packing. Start from its minimal `templates/index.html` (which already has keyboard navigation) and apply the design principles below on top. Don't reinvent the plumbing.

## Design Thinking

Before coding, understand the context and commit to a BOLD aesthetic direction:
- **Purpose**: What is this deck arguing for? Who watches it live, who reads it later?
- **Tone**: Pick an extreme: brutally minimal, maximalist chaos, retro-futuristic, organic/natural, luxury/refined, playful/toy-like, editorial/magazine, brutalist/raw, art deco/geometric, soft/pastel, industrial/utilitarian, etc. There are so many flavors to choose from. Use these for inspiration but design one that is true to the aesthetic direction.
- **Constraints**: Technical requirements (performance, accessibility) AND the deck's dual role — it must work both on a projector in a live talk and as a document someone reads alone later.
- **Differentiation**: What makes this UNFORGETTABLE? What's the one thing someone will remember after the talk?

**CRITICAL**: Choose a clear conceptual direction and execute it with precision. Bold maximalism and refined minimalism both work - the key is intentionality, not intensity.

Then implement working code (single `index.html` with inline CSS/JS, or split files — all relative paths) that is:
- Production-grade and functional
- Visually striking and memorable
- Cohesive with a clear aesthetic point-of-view
- Meticulously refined in every detail

## Frontend Aesthetics Guidelines

Focus on:
- **Typography**: Choose fonts that are beautiful, unique, and interesting. Avoid generic fonts like Arial and Inter; opt instead for distinctive choices that elevate the deck's aesthetics; unexpected, characterful font choices. Pair a distinctive display font with a refined body font. Decks are read at a distance — size body copy one step larger than you would on a landing page. The Deck App's CSP blocks external fonts, so vendor `.woff2` files into the deck and define `@font-face` with relative `src:`.
- **Color & Theme**: Commit to a cohesive aesthetic. Use CSS variables for consistency. Dominant colors with sharp accents outperform timid, evenly-distributed palettes.
- **Motion**: Use animations for effects and micro-interactions. Prioritize CSS-only solutions. Focus on high-impact moments: a well-orchestrated staggered reveal (animation-delay) fired **every time a slide becomes active** creates the signature rhythm of a deck — not a one-time page-load moment. Avoid scroll-triggered effects entirely; a deck is a paged medium, not a scrolling one.
- **Spatial Composition**: Unexpected layouts. Asymmetry. Overlap. Diagonal flow. Grid-breaking elements. Generous negative space OR controlled density. But every slide must let the audience grasp its point within two seconds — grid-breaking must serve that clarity, not fight it.
- **Backgrounds & Visual Details**: Create atmosphere and depth rather than defaulting to solid colors. Add contextual effects and textures that match the overall aesthetic. Apply creative forms like gradient meshes, noise textures, geometric patterns, layered transparencies, dramatic shadows, decorative borders, custom cursors, and grain overlays.

NEVER use generic AI-generated aesthetics like overused font families (Inter, Roboto, Arial, system fonts), cliched color schemes (particularly purple gradients on white backgrounds), predictable layouts and component patterns, and cookie-cutter design that lacks context-specific character.

Deck-specific anti-patterns to avoid:
- A giant hero animation on the cover that burns 3 seconds before any content appears — on stage, that's dead air.
- Cramming a slide by shrinking type instead of splitting it into two. If it doesn't fit at the intended size, it's two slides.
- Hiding key information behind `:hover` — projectors have no cursor, and a passive reader won't discover it either.
- Shipping a "naked" deck with no page counter, no keyboard hint, no way to jump between slides. The audience needs to know where they are.

Interpret creatively and make unexpected choices that feel genuinely designed for the context. No design should be the same. Vary between light and dark themes, different fonts, different aesthetics. NEVER converge on common choices (Space Grotesk, for example) across generations.

**IMPORTANT**: Match implementation complexity to the aesthetic vision. Maximalist designs need elaborate code with extensive animations and effects. Minimalist or refined designs need restraint, precision, and careful attention to spacing, typography, and subtle details. Elegance comes from executing the vision well.

## Deck-specific constraints

These are properties of the Deck App medium, not aesthetic choices — ignore them and the deck physically breaks:

- **Pagination is the author's job.** The Deck App has no concept of a "slide." Wire your own `keydown` listener for `ArrowLeft`/`ArrowRight`/`PageUp`/`PageDown`/`Space`/`Home`/`End`.
- **Provide chrome.** A visible page counter, a keyboard hint, and some way to jump between slides (pills, a TOC, or both). The audience needs orientation; the lone reader needs navigation.
- **Design for dual use.** The same deck is projected live and read alone later — allow `overflow-y:auto` inside slides for dense pages, and include a sensible `@media print` style.
- **Sandbox reality.** The Deck App enforces a strict CSP: no external network, no CDN scripts, no Google Fonts `<link>`, no remote images. Vendor everything into the deck and use relative paths. There is no `window.deck` API — `index.html` is a plain page.

Remember: AI is capable of extraordinary creative work. Don't hold back, show what can truly be created when thinking outside the box and committing fully to a distinctive vision.
