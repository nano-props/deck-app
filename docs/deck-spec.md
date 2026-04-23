# Deck Format Specification

**Version:** v1.0
**Date:** 2026-04-23

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
  "drag": "auto", // window drag behavior — see §6
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
| `drag`        | ✗        | Window drag behavior: `"auto"` (default) or `"off"`. See §6.      |

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

## 6. Window drag behavior

Because the Player has no visible titlebar, drag-to-move is provided by CSS injected into the author page. The `drag` field in `deck.json` picks the strategy.

| Value    | Behavior                                                                                                                                                          |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"auto"` | **Default.** `<body>` is a drag region; common interactive elements (see list below) are carved back out as `no-drag`. Most Decks work with zero configuration.   |
| `"off"`  | The Deck App installs no drag CSS at all. The author owns the window drag behavior entirely — e.g. a canvas-based Deck that needs every pixel for pointer events. |

The `"auto"` mode's `no-drag` selector list covers:

- `<a>`, `<button>`, `<input>`, `<textarea>`, `<select>`, `<label>`
- `<video>`, `<audio>`, `<iframe>`, `<embed>`, `<object>`
- Any element with `role="button" | "link" | "textbox" | "slider" | "checkbox" | "radio" | "menuitem" | "tab"`
- Any element with `contenteditable` (except `contenteditable="false"`)

**Valid values only.** `drag` must be one of `"auto"` or `"off"`. The field is optional — omit it to get the default. Values are **case-sensitive**. An invalid value (wrong case, unknown string, non-string type) is a Deck authoring error; the Deck App defaults to `"auto"` and logs a warning, but Decks must not rely on that behavior. If a future v1.x spec adds more modes, older Deck Apps will treat the new modes as invalid and fall back to `"auto"`.

**Author overrides.** `-webkit-app-region` is a standard CSS property in the Electron/Chromium runtime. A leaf element's `no-drag` wins over an ancestor's `drag`, and vice versa — so authors can always override the defaults:

```css
/* opt a custom interactive element out of drag */
.my-clickable-div {
  -webkit-app-region: no-drag;
}

/* opt a specific zone into drag, even under `drag: "off"` */
.my-titlebar {
  -webkit-app-region: drag;
}
```

**Platform.** The auto CSS is only installed on macOS; on Windows and Linux the window ships with a native titlebar that already provides drag, so `"auto"` is effectively a no-op there. `"off"` is honored on every platform (it simply means "don't install anything").

---

## 7. Example

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

## 8. Versioning

- **v1.0** — this document.
- **Future** — add `permissions` (network / clipboard), `theme`, signing, etc. on demand. Guiding principle: _don't add it unless you must, and if you do, it must be optional._

**Compatibility promise:** within v1.x, unknown fields must be ignored. An older Deck must never fail to open in a newer Deck App.

---

## 9. Integrity and signing — deferred design notes

v1.0 does **not** specify integrity hashes or signatures. A Deck Pack is just a zip; anyone with the file can modify it. This section records the intended future direction so the format does not drift into a corner that makes it hard to add later.

### 9.1 Why not in v1.0

- An in-manifest hash (e.g. `deck.json` listing SHA-256 of each file) provides no real protection: an attacker who modifies a file can recompute the hash and rewrite `deck.json`. It only catches accidental corruption — which zip's own CRC32 already catches.
- Real tamper resistance requires an **external trust anchor** — something outside the `.deck` file that the attacker cannot rewrite. Adding that (key storage, UI, trust management) is a significant surface we are not ready to commit to.
- Per the guiding principle in §8: don't add it unless you must.

### 9.2 Reference model: VSIX

When signing is added, the reference is the **VSIX approach** (VS Code extensions):

- The package format itself stays a plain zip — unsigned packages still open.
- Signing is **transport / distribution concern**, not a format concern: the Marketplace (HTTPS + account-bound publishing) is the primary trust anchor.
- A separate signing layer can be added later without changing the package format, by shipping signatures out-of-band or in a reserved file (e.g. `.signature.p7s` inside the zip) that older clients ignore.

This matches §8's compatibility promise: older Deck Apps will ignore the signature file and open the Deck as usual; newer Deck Apps that understand the signature can surface trust UI.

### 9.3 When to revisit

Re-open this design when any of the following becomes true:

- A Deck distribution channel (marketplace, gallery, share-link service) ships — at that point HTTPS + account binding is the cheapest first trust anchor.
- Users report a real incident of a tampered Deck in the wild.
- A use case demands author-identity continuity across versions (e.g. "this update really is from the same author as the Deck I trusted last week"). That's the point at which a TOFU + key-pinning scheme (Chrome-extension style) starts to pull its weight.

### 9.4 Constraints on any future design

Whatever the eventual design, it **must**:

- Keep unsigned Decks openable (signing is optional, per §8).
- Not require network access at open time for the common case.
- Not change the rule that a Deck Pack unzipped into a directory is a valid Deck Source — i.e. signing artifacts live in files that are inert when extracted to disk and loaded by a plain browser.
