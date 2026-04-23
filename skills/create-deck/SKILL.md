---
name: create-deck
description: Author a Deck (the `.deck` presentation format) — create a Deck Source directory with `deck.json` + `index.html`, build the slides as a self-contained static site, and optionally pack it into a `.deck` Deck Pack for distribution. Use whenever the user asks to "create a deck", "make a presentation", "build slides", "write a .deck", or "pack a deck".
---

# Creating a Deck

A **Deck** is a presentation format opened by the Deck App. The spec is tiny:

> **A Deck Pack is a zipped static website with a `deck.json` manifest inside.**

Before doing anything non-trivial, read the two references shipped with this skill (both are lite, author-oriented digests of the Deck v1.0 specification):

- `reference/spec-lite.md` — the format rules an author needs. Any rule there overrides this SKILL.md.
- `reference/terminology-lite.md` — vocabulary and app views. Use these exact terms; don't invent synonyms.

Core vocabulary you'll use constantly: **Deck** (the presentation), **Deck Source** (the directory you author), **Deck Pack** (the `.deck` file you distribute), **Deck Manifest** (`deck.json`), **pack a Deck** (zip Source → Pack). Never say "deck file", "deck project", or "extracted folder" — see `reference/terminology-lite.md` for the full list and the anti-patterns.

---

## Where to put the Deck

Unless the user specifies a location, create the Deck Source as a subdirectory of the current working directory, named after the Deck (slugified):

```
<cwd>/<slug>/         ← Deck Source (what you author)
<cwd>/<slug>.deck     ← Deck Pack (what you hand out, after packing)
```

If the user explicitly names a target directory, use that instead.

---

## Authoring flow

1. **Create the Deck Source directory** `<slug>/`.
2. **Write `deck.json`** — only `name` is required. `author`, `description`, `cover`, `version`, `drag` are optional. No spec-version field exists in v1. See `reference/spec-lite.md` §2 for fields and §6 for `drag` semantics.
3. **Write `index.html`** — the entry point. Filename is fixed; it must sit at the root of the Deck Source.
4. **Add any assets** (CSS, JS, images, fonts, video) inside the same directory, referenced by **relative paths**. Nested folders are fine.
5. **Preview**: have the user open the Deck Source directory from the Deck App Launcher (or double-click the `.deck` after packing).
6. **Pack** (when distributing): zip the directory — see below.

The Deck App opens a Deck Source directly — the user does **not** need to pack in order to test. Packing is only for distribution.

---

## Minimum viable Deck Source

```
hello/
├── deck.json
└── index.html
```

Start from the templates shipped with this skill:

- `templates/index.html` — a minimal Deck with arrow-key / Space / PageUp-Down / Home / End pagination and a slide counter, already wired up. Copy to `<slug>/index.html`, replace the `<section class="slide">` blocks with real content, and substitute the `<deck-name>` placeholder in `<title>` with the real Deck name.
- `templates/deck.json` — just `{ "name": "<deck-name>" }`. Replace the placeholder with the real Deck name (same value as the one in `index.html`'s `<title>`). Add `author`, `description`, `version`, `drag` when the user provides them. Don't invent values.

---

## Hard rules (the sandbox is tight)

Four easy-to-miss rules. Read `reference/spec-lite.md` §4–§5 for the full CSP string, the complete forwarded-key list, and rationale.

- **No external network.** Strict CSP blocks all cross-origin fetches — no CDN scripts, no Google Fonts `<link>`, no remote images, no third-party `fetch()`. **Vendor everything** into the Deck Source and use relative paths. `data:` / `blob:` URLs are fine for images.
- **No `window.deck` API.** `index.html` is a plain web page; nothing is injected.
- **Pagination is the author's job.** The Deck App has no concept of a "slide". Wire your own `keydown` listener (the minimal template already does) or vendor a framework like reveal.js.
- **Don't bind container keys.** `Esc`, `F11`, `Cmd+Ctrl+F` are swallowed by the Deck App; everything else (arrows, Space, letters, …) reaches the page.

Forward compatibility: unknown `deck.json` fields are ignored. Don't block on schema validation.

---

## Packing a Deck

A Deck Pack is literally a ZIP of the Deck Source, renamed to `.deck`. Use the system `zip` command — no build tools, no dependencies:

```bash
# From the parent of the Deck Source:
cd <parent-of-source>
rm -f <slug>.deck                                   # overwrite any previous pack
(cd <slug> && zip -r ../<slug>.deck . -x '.*' -x '*/.*')
```

The `-x '.*' -x '*/.*'` flags skip dotfiles (`.DS_Store`, `.git/`, editor junk) so the pack stays clean.

**Before zipping, verify**:

- `<slug>/deck.json` exists and is valid JSON with a `name` field.
- `<slug>/index.html` exists at the root of `<slug>/`.

If either is missing, fix it before packing — the Deck App will refuse to open a pack without them.

**Unzip to inspect**: a `.deck` is a standard zip, so `unzip <slug>.deck -d /tmp/check` works fine for sanity checks.

---

## Common asks and how to handle them

- **"Make me a 5-slide deck about X"** — create `<slug>/` with the minimal template, fill in 5 `<section class="slide">` blocks, leave the pager JS alone.
- **"Use Google Fonts"** — don't link the CDN. Download the `.woff2` into `<slug>/fonts/` and define `@font-face` in CSS with a relative `src:`.
- **"Use reveal.js"** — vendor it: copy `dist/` into the Deck Source and reference `./reveal.js` / `./reveal.css` with relative paths.
- **"Add a cover image"** — drop it into the Deck Source and reference it relatively in `deck.json` via `"cover": "cover.png"`. This is used by the Deck App Launcher as the Deck's thumbnail; it is independent of `index.html` (don't auto-add an `<img>` to the first slide unless the user asks).
- **"Canvas / WebGL deck where clicks get swallowed"** — set `"drag": "off"` in `deck.json` so the Player injects no drag CSS; the author then owns window drag entirely (see `reference/spec-lite.md` §6).
- **"Text on slides can't be selected"** — the default `drag: "auto"` makes most of `<body>` a drag region, which kills text selection on non-interactive elements. Opt specific elements out with `-webkit-app-region: no-drag` in CSS (e.g. `h1, p { -webkit-app-region: no-drag; }`), or flip to `drag: "off"` entirely.
- **"Ship it"** — run the pack command above; hand the user `<slug>.deck`.

---

## Checklist before handing back

- [ ] `<slug>/deck.json` exists, is valid JSON, and has at least `name`.
- [ ] `<slug>/index.html` exists at the root of the Deck Source.
- [ ] No external URLs in `<script src>`, `<link href>`, `<img src>`, `fetch()`, `@import`, `url(...)`. Everything is a relative path or inline.
- [ ] Pagination (or whatever interaction model you built) is wired to the page's own `keydown` listener.
- [ ] If the user asked for a pack, the `.deck` was produced with the pack command above and unzips cleanly.
