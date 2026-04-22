# Deck Format Specification

**Version:** v1.0
**Date:** 2026-04-22

> Terminology follows [`terminology.md`](./terminology.md). Key terms used here: **Deck**, **Deck Pack**, **Deck Source**, **Deck Manifest**, **Deck App**.

---

## Core definition

> **A Deck Pack is a zipped static website with a `deck.json` manifest inside.**

That's the whole idea. The rest of this document is the details.

---

## 1. File format

- A **Deck Pack** (`.deck` file) is a standard **ZIP** archive.
- It **must** contain two files at the root:
  - `deck.json` — the Deck Manifest.
  - `index.html` — the entry point (fixed filename, not configurable).
- Anything else is allowed: CSS, JS, images, fonts, video, nested directories — all fine.
- A **Deck Source** (the unpacked directory form) has **the same layout** as an unpacked Deck Pack. The Deck App supports both forms equally.

**Minimal Deck Pack:**

```
hello.deck
├── deck.json
└── index.html
```

---

## 2. `deck.json` (Deck Manifest)

```jsonc
{
  "name": "My Presentation", // required

  // everything below is optional
  "author": "Ada",
  "description": "A talk about Transformers",
  "cover": "cover.png",
  "version": "1.0.0", // version of this Deck (author-maintained)
}
```

**Fields:**

| Field         | Required | Description                                                       |
| ------------- | -------- | ----------------------------------------------------------------- |
| `name`        | ✓        | The Deck's name (used in lists, window titles, export filenames). |
| `author`      | ✗        | String.                                                           |
| `description` | ✗        | Short description.                                                |
| `cover`       | ✗        | Relative path to a cover image.                                   |
| `version`     | ✗        | Version number of this Deck (SemVer, author-maintained).          |

> The entry point is always `index.html` at the root. It is not declared in `deck.json`.

**Forward compatibility:** implementations **must** ignore unknown fields without erroring. Any future field will be optional.

**Why is there no spec-version field?** v1 is the only version, so it doesn't need to be declared. If a v2 format ships later, v2 Decks can carry a field like `spec: "2.0"` — v1 Deck Apps that don't recognize it will ignore it and continue to parse the Deck as v1, preserving compatibility.

---

## 3. How the Deck App opens a Deck

**Opening a Deck Pack:**

1. Extract the Deck Pack into a temporary directory (yielding an ephemeral Deck Source).
2. Read `deck.json`, verify required fields (`name`), and confirm `index.html` exists at the root.
3. Start a local HTTP server (`127.0.0.1` on a random port) hosting that directory.
4. Load `http://127.0.0.1:<port>/` in the Player (which resolves to `index.html`).
5. On close: stop the server and delete the temp directory.

**Opening a Deck Source:**

Same flow, but step 1 is skipped (no extraction needed) — the server hosts the user's directory directly. On close the server stops but **the user's directory is not touched**.

**Any browser should be able to open `index.html` after unzipping a Deck Pack and see the Deck.** That is the baseline the spec guarantees.

---

## 4. Security

When the Deck App loads a Deck, the following constraints apply:

- The local server binds to `127.0.0.1` only.
- Electron window settings: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.
- Default CSP: `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'`.
- **Cross-origin network requests are forbidden by default.**
- **No runtime API is injected into the author's window.** There is no `window.deck` global. The author page is a plain web page.

If a Deck author needs network, clipboard, or similar capabilities, a future spec version will gate them through a `permissions` field. v1.0 does not support this.

---

## 5. Keyboard events

**The Deck App does not implement pagination, nor does it define the concept of a "slide".** Turning pages, scrolling, switching — all of that is the author's job, inside the page.

The Deck App is only a container. It **forwards keyboard events to the page transparently**. Authors listen with the standard Web APIs:

```js
window.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight') nextSlide()
  if (e.key === 'ArrowLeft') prevSlide()
})
```

All keys reach the page (arrows, Space, PageUp/Down, letter keys, and so on). The Deck App does not swallow them, and does not inject any scripts.

**The only exceptions** are "container-level" shortcuts handled by the Deck App itself and not forwarded:

- `Esc` — exit fullscreen / presentation mode.
- `F11` / `Cmd+Ctrl+F` — toggle fullscreen.
- Browser dev tools, window controls, and other OS-level shortcuts.

This gives authors full freedom to use any slide framework they like — reveal.js, Swiper, a custom engine, plain scroll — without the Deck App getting in the way.

---

## 6. Example

**deck.json**

```json
{
  "name": "Hello Deck",
  "author": "Ada"
}
```

**index.html**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Hello Deck</title>
    <style>
      body {
        margin: 0;
      }
      .slide {
        height: 100vh;
        display: grid;
        place-items: center;
      }
      .slide:not(.active) {
        display: none;
      }
    </style>
  </head>
  <body>
    <section class="slide active"><h1>Hello, Deck</h1></section>
    <section class="slide"><h1>Second slide</h1></section>
    <section class="slide"><h1>The end</h1></section>
    <script>
      let i = 0
      const slides = document.querySelectorAll('.slide')
      const show = (n) => {
        i = Math.max(0, Math.min(slides.length - 1, n))
        slides.forEach((s, idx) => s.classList.toggle('active', idx === i))
      }
      window.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight' || e.key === ' ') show(i + 1)
        if (e.key === 'ArrowLeft') show(i - 1)
      })
    </script>
  </body>
</html>
```

Drop these two files in the same directory and you have a Deck Source. Zip them and rename to `.deck` and you have a Deck Pack. The Deck App opens either form directly.

---

## 7. Versioning

- **v1.0** — this document.
- **Future** — add `permissions` (network / clipboard), `theme`, signing, etc. on demand. Guiding principle: _don't add it unless you must, and if you do, it must be optional._

**Compatibility promise:** within v1.x, unknown fields must be ignored. An older Deck must never fail to open in a newer Deck App.
