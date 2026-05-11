---
name: edit-deck
description: Author or transform the currently-open Deck inside Deck App Editor by editing its files in place. Use when the user asks to create, build, redesign, or modify a deck while running inside the Deck App Editor. Do not pack or write a `.deck` file; the app handles saving.
---

# Editing a Deck in Deck App Editor

Use this skill when you are running inside Deck App Editor. The system prompt will say that you are "Deck AI" and will provide:

```
The Deck Source lives at: <path>
```

In this environment, the user already has a Deck open. Even if the user says "create a deck", your job is to turn the current Deck Source into the requested presentation.

Before doing anything non-trivial, read the two references shipped with this skill:

- `reference/spec-lite.md` — the format rules an author needs.
- `reference/terminology-lite.md` — vocabulary and app views.

---

## Editor-mode rules

- Edit the current Deck Source in place.
- Do not create a sibling working directory.
- Do not pack, zip, export, or write a `.deck` file.
- Do not write outside the Deck Source.
- Use `write` / `edit` for `deck.json` and `index.html`.
- Use `add_asset` or `fetch_url` for assets.
- After structural edits, call `validate_deck`.
- When validation passes, tell the user the deck is ready. The Deck App handles Save / close and writes back to the opened `.deck` when appropriate.

---

## Deck Source shape

A Deck Source is a static website directory with these required root files:

```
deck.json
index.html
```

`deck.json` must contain at least:

```json
{ "name": "Deck Name" }
```

`index.html` is the entry point. Put CSS, JavaScript, and markup there, or add relative assets under folders like `assets/`, `styles/`, or `scripts/`.

---

## Authoring flow in Editor

1. Inspect the existing Deck Source with `ls`, `read`, `grep`, or `find`.
2. Plan the slide/content structure based on the user's request.
3. Update `deck.json` if the name, description, author, cover, or version should change.
4. Update `index.html` and any local assets.
5. Keep all references relative or inline.
6. Run `validate_deck`.
7. Fix validation issues if any.
8. Reply with a concise completion summary.

---

## Hard rules

- **No external network at runtime.** The Deck App enforces a strict CSP: no CDN scripts, no Google Fonts `<link>`, no remote images, no third-party `fetch()`. Vendor everything into the Deck Source and use relative paths. `data:` / `blob:` URLs are fine for images.
- **No `window.deck` API.** `index.html` is a plain web page; nothing is injected.
- **Pagination is the author's job.** The Deck App has no concept of a "slide". Wire your own `keydown` listener or use vendored local framework files.
- **Don't bind container keys.** `Esc`, `F11`, `Cmd+Ctrl+F`, and most `Cmd`/`Ctrl` menu shortcuts are intercepted by the app. Plain keys such as arrows, Space, letters, and PageUp/PageDown reach the page.

---

## Common asks

- **"Create a deck about X"** — overwrite or expand the current Deck Source into that deck; do not create a new `.deck`.
- **"Make a 5-slide deck"** — implement five slide sections in `index.html`, with keyboard pagination.
- **"Use Google Fonts"** — do not link Google Fonts. Use system font stacks or add local font files.
- **"Add a cover image"** — add it inside the Deck Source and reference it relatively from `deck.json` via `"cover": "assets/cover.png"` if the user asked for a manifest cover.
- **"Save it" / "Export it"** — explain that the Deck App handles saving the opened `.deck`; do not write a new pack.

---

## Checklist before handing back

- [ ] `deck.json` exists, is valid JSON, and has a non-empty `name`.
- [ ] `index.html` exists at the Deck Source root.
- [ ] No external URLs in `<script src>`, `<link href>`, `<img src>`, `fetch()`, `@import`, or `url(...)`, except intentional inline `data:` / `blob:` URLs.
- [ ] Pagination or the chosen interaction model is wired inside the page.
- [ ] `validate_deck` passed, or any remaining issue is explicitly reported.
