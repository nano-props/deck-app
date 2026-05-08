---
name: create-deck
description: Author a Deck (the `.deck` presentation format) — build the slides as a self-contained static site in a working directory, then pack it into a `.deck` file for the user. Use whenever the user asks to "create a deck", "make a presentation", "build slides", "write a .deck", or "pack a deck".
---

# Creating a Deck

A **Deck** is a presentation format opened by the Deck App. The spec is tiny:

> **A Deck Pack is a zipped static website with a `deck.json` manifest inside.**

Before doing anything non-trivial, read the two references shipped with this skill (both are lite, author-oriented digests of the Deck v1.0 specification):

- `reference/spec-lite.md` — the format rules an author needs. Any rule there overrides this SKILL.md.
- `reference/terminology-lite.md` — vocabulary and app views. Use these exact terms; don't invent synonyms.

Core vocabulary: **Deck** (the presentation), **Deck Pack** (the `.deck` file — the user-facing form, both for editing in the Deck App and for distribution), **Deck Source** (an unpacked directory — useful as a working area while authoring, but not a user-facing concept in the Deck App), **Deck Manifest** (`deck.json`), **pack a Deck** (zip Source → Pack). See `reference/terminology-lite.md` for the full table and anti-patterns.

---

## Where to put the Deck

Unless the user specifies a location, build the Deck Source as a subdirectory of the current working directory, named after the Deck (slugified), and pack it alongside:

```
<cwd>/<slug>/         ← working directory while authoring
<cwd>/<slug>.deck     ← what you hand to the user
```

You normally hand the user the `.deck`; the directory is a working artifact. Keep or remove it based on the user's preference.

---

## Authoring flow

1. **Create the working directory** `<slug>/`.
2. **Write `deck.json`** — only `name` is required. `author`, `description`, `cover`, `version` are optional. No spec-version field exists in v1. See `reference/spec-lite.md` §2 for fields.
3. **Write `index.html`** — the entry point. Filename is fixed; it must sit at the root.
4. **Add any assets** (CSS, JS, images, fonts, video) inside the same directory, referenced by **relative paths**. Nested folders are fine.
5. **Pack** the directory into `<slug>.deck` — see below.
6. **Preview**: hand the user `<slug>.deck` to double-click. The Deck App opens it directly; users edit it in place via the Editor, and edits are flushed back to the `.deck` on Save / close.

You can also iterate on the directory directly via the Deck App's `File → Open Folder…` (the Editor opens the directory and writes through to it). The Pack the user gets is still the `.deck` you produce in step 5.

---

## Minimum viable Deck

```
hello/
├── deck.json
└── index.html
```

Start from the templates shipped with this skill:

- `templates/index.html` — a minimal Deck with arrow-key / Space / PageUp-Down / Home / End pagination and a slide counter, already wired up. Copy to `<slug>/index.html`, replace the `<section class="slide">` blocks with real content, and substitute the `<deck-name>` placeholder in `<title>` with the real Deck name.
- `templates/deck.json` — just `{ "name": "<deck-name>" }`. Replace the placeholder with the real Deck name (same value as the one in `index.html`'s `<title>`). Add `author`, `description`, `version` when the user provides them. Don't invent values.

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

A Deck Pack is literally a ZIP of the working directory, renamed to `.deck`. Use the system `zip` command — no build tools, no dependencies:

```bash
# From the parent of the working directory:
cd <parent-of-source>
rm -f <slug>.deck                                   # overwrite any previous pack
(cd <slug> && zip -r ../<slug>.deck . -x '.*' -x '*/.*')
```

The `-x '.*' -x '*/.*'` flags skip dotfiles (`.DS_Store`, `.git/`, editor junk) so the pack stays clean.

**Before zipping, verify**:

- `<slug>/deck.json` exists and is valid JSON with a `name` field.
- `<slug>/index.html` exists at the root of `<slug>/`.

If either is missing, fix it before packing — the Deck App will refuse to open a `.deck` without them.

**Unzip to inspect**: a `.deck` is a standard zip, so `unzip <slug>.deck -d /tmp/check` works fine for sanity checks.

---

## Common asks and how to handle them

- **"Make me a 5-slide deck about X"** — create `<slug>/` with the minimal template, fill in 5 `<section class="slide">` blocks, leave the pager JS alone.
- **"Use Google Fonts"** — don't link the CDN. Download the `.woff2` into `<slug>/fonts/` and define `@font-face` in CSS with a relative `src:`.
- **"Use reveal.js"** — vendor it: copy `dist/` into the working directory and reference `./reveal.js` / `./reveal.css` with relative paths.
- **"Add a cover image"** — drop it into the working directory and reference it relatively in `deck.json` via `"cover": "cover.png"`. The field is reserved in the spec for a future Launcher thumbnail; the Deck App ignores it today, so don't promise the user it'll show up automatically. It's still independent of `index.html` (don't auto-add an `<img>` to the first slide unless the user asks).
- **"Add a header / nav bar / logo at the top"** — place it at `top: 0` like any other web page. The chrome topbar (with traffic lights / caption buttons) sits above the Deck viewport; the Deck's own viewport starts below it, so `top: 0` in the Deck is flush with the chrome's bottom edge — clickable, visible, and not covered by traffic lights. See `reference/spec-lite.md` §6.
- **"Ship it"** — run the pack command above; hand the user `<slug>.deck`.

---

## Checklist before handing back

- [ ] `<slug>/deck.json` exists, is valid JSON, and has at least `name`.
- [ ] `<slug>/index.html` exists at the root of `<slug>/`.
- [ ] No external URLs in `<script src>`, `<link href>`, `<img src>`, `fetch()`, `@import`, `url(...)`. Everything is a relative path or inline.
- [ ] Pagination (or whatever interaction model you built) is wired to the page's own `keydown` listener.
- [ ] `<slug>.deck` was produced with the pack command above and unzips cleanly.
