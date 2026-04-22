---
name: create-deck
description: Author a Deck (the `.deck` presentation format used by this project) — create a Deck Source directory with `deck.json` + `index.html`, build the slides as a self-contained static site, preview it, and optionally pack it into a `.deck` Deck Pack. Use whenever the user asks to "create a deck", "make a presentation", "build slides", "write a .deck", "pack a deck", or edits anything under `examples/<name>/`.
---

# Creating a Deck

A **Deck** is this project's presentation format. The spec is tiny:

> **A Deck Pack is a zipped static website with a `deck.json` manifest inside.**

Authoritative docs in this repo:
- `docs/deck-spec.md` — the format (read before deviating from defaults).
- `docs/terminology.md` — vocabulary (use it; don't invent synonyms).
- `docs/deck.md` — the Deck App product doc.

Before doing anything non-trivial, skim `docs/deck-spec.md` — it is short and any rule there overrides this skill.

---

## Vocabulary (use these exact terms)

| Term             | What it means                                                                       |
| ---------------- | ----------------------------------------------------------------------------------- |
| **Deck**         | A single presentation (the abstract thing).                                         |
| **Deck Source**  | The unpacked directory form. `examples/<name>/` — what you author/edit.             |
| **Deck Pack**    | The zipped `.deck` file. `examples/<name>.deck` — what you distribute.              |
| **Deck Manifest**| `deck.json` at the root.                                                            |
| **pack a Deck**  | Zip a Deck Source into a Deck Pack.                                                 |

Do **not** say "deck file", "deck project", "extracted folder". See `docs/terminology.md` anti-patterns.

---

## Where decks live

Sample decks go under `examples/<name>/` (which is gitignored). The packer script, `scripts/pack-deck.ts`, is hard-coded to read from `examples/<name>/` and write `examples/<name>.deck`. Use that convention unless the user says otherwise.

---

## Authoring flow

1. **Create the Deck Source directory**: `examples/<name>/`.
2. **Write `deck.json`** — only `name` is required; `author`, `description`, `cover`, `version` are optional. No spec-version field exists in v1.
3. **Write `index.html`** — the entry point. Filename is fixed; not configurable. It must sit at the root of the Deck Source.
4. **Add any assets** (CSS, JS, images, fonts, video) inside the same directory, referenced by **relative paths**. Nested folders are fine.
5. **Preview** (optional): `bun run dev` starts the Deck App; open the `examples/<name>/` folder from the Launcher, or double-click `examples/<name>.deck` after packing.
6. **Pack** (when distributing): `bun run pack:deck <name>` → writes `examples/<name>.deck`.

The Deck App opens a Deck Source directly — you do **not** need to pack in order to test.

---

## Minimum viable Deck Source

```
examples/hello/
├── deck.json
└── index.html
```

Use the `templates/minimal.html` file in this skill as a starting point — it has arrow-key / Space / PageUp-Down / Home / End pagination and a slide counter already wired up. Duplicate it into `examples/<name>/index.html` and replace the `<section class="slide">` blocks with real content.

A bare `deck.json`:

```json
{
  "name": "My Deck"
}
```

Add `author`, `description`, `version` when the user provides them. Don't invent values.

---

## Hard rules (the sandbox is tight)

The Player applies a strict CSP and sandbox. Authoring against this by accident leads to silent failures.

- **No external network requests.** The default CSP is `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'`. That means:
  - No `<script src="https://cdn...">`, no Google Fonts `<link href="https://fonts...">`, no remote images, no `fetch()` to third-party APIs.
  - Vendor everything. Download fonts/libraries into the Deck Source and reference them with relative paths.
  - `data:` and `blob:` URLs are OK for images.
- **No `window.deck` runtime API.** The Deck App does not inject anything into the page — treat `index.html` as a plain web page.
- **Pagination is the author's job.** The Deck App doesn't know what a "slide" is. Build it yourself (CSS classes + keydown listener) or use a framework like reveal.js / Swiper (vendored locally). The minimal template already does this.
- **Keyboard events reach the page.** Arrow keys, Space, PageUp/Down, letters — all forwarded. You listen via `window.addEventListener('keydown', ...)`.
- **Container-level keys are swallowed by the Deck App** (don't try to bind them): `Esc`, `F11`, `Cmd+Ctrl+F`, plus OS/DevTools shortcuts.
- **Forward compatibility**: unknown `deck.json` fields are ignored. Don't block on schema validation.

---

## Packing a Deck

```bash
bun run pack:deck <name>
# reads   examples/<name>/
# writes  examples/<name>.deck   (overwritten if it exists)
```

The packer skips dotfiles (`.DS_Store`, etc.) so the pack stays clean. It validates that `deck.json` and `index.html` both exist at the root before zipping — if either is missing the script exits non-zero.

A Deck Pack is just a ZIP — you can unzip it with any tool and inspect it.

---

## Common asks and how to handle them

- **"Make me a 5-slide deck about X"** — create `examples/<slug>/` with the minimal template, fill in 5 `<section class="slide">` blocks, leave the pager JS alone.
- **"Use Google Fonts"** — don't link the CDN. Download the `.woff2` into `examples/<slug>/fonts/` and define `@font-face` in CSS with a relative `src:`.
- **"Use reveal.js"** — vendor it: copy `dist/` into the Deck Source and reference `./reveal.js` / `./reveal.css` with relative paths.
- **"Add a cover image"** — drop it into the Deck Source, reference it relatively in `deck.json` via `"cover": "cover.png"`, and use it in HTML as `<img src="cover.png">`.
- **"Ship it"** — run `bun run pack:deck <name>` and hand the user `examples/<name>.deck`.

---

## Checklist before handing back

- [ ] `examples/<name>/deck.json` exists and has at least `name`.
- [ ] `examples/<name>/index.html` exists at the root.
- [ ] No external URLs in `<script src>`, `<link href>`, `<img src>`, `fetch()`, etc. Everything is a relative path or inline.
- [ ] Pagination (or whatever interaction model you built) is wired to the page's own `keydown` listener.
- [ ] If the user asked for a pack, `bun run pack:deck <name>` ran cleanly.
