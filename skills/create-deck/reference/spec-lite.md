# Deck Format — Lite Reference (v1.0)

> This is a lite, author-oriented digest of the Deck v1.0 specification, scoped to what you need to build a `.deck`. It omits deep sections (CSP rationale, open-flow internals, signing/integrity design notes) that aren't needed for authoring. Treat this as sufficient for normal Deck creation; if an edge case isn't covered here, it isn't covered by this skill.

## 1. File layout

**A Deck Pack is a zipped static website with a `deck.json` manifest inside.** That's the whole idea; the rest of this document is detail.

A Deck Pack (`.deck`) is a **standard ZIP** containing, at its root:

- `deck.json` — the Deck Manifest (required).
- `index.html` — the entry point. Filename is fixed, not configurable (required).
- Any other assets: CSS, JS, images, fonts, video, nested folders — all fine.

A Deck Source has the exact same layout, just unzipped. The Deck App opens either form.

```
hello.deck           hello/               ← Deck Source (equivalent, unzipped)
├── deck.json   ==   ├── deck.json
└── index.html       └── index.html
```

## 2. `deck.json` (Deck Manifest)

```jsonc
{
  "name": "My Presentation",  // required

  // everything below is optional
  "author": "Ada",
  "description": "A talk about Transformers",
  "cover": "cover.png",       // relative path to a cover image
  "version": "1.0.0",         // SemVer, author-maintained
  "drag": "auto"              // "auto" (default) or "off" — see §5
}
```

Unknown fields are ignored (forward compatibility). Don't invent fields.

## 3. How the Deck App runs a Deck

1. (Deck Pack only) Extract into a temp directory.
2. Read `deck.json`, verify `name` and that `index.html` exists at the root.
3. Start a local HTTP server on `127.0.0.1:<random-port>` rooted at the directory.
4. Load `http://127.0.0.1:<port>/` in the Player window.
5. On close: stop the server; if it was a Deck Pack, delete the temp directory.

Any browser can open the unzipped `index.html` and see the Deck. That's the baseline.

## 4. Security sandbox — **read this**

The Player applies a strict CSP and sandbox. Violating these leads to silent failures.

- **No external network.** Default CSP: `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'`. Meaning:
  - No `<script src="https://cdn...">`.
  - No Google Fonts `<link href="https://fonts...">`.
  - No remote images, no `fetch()` to third-party APIs.
  - **Vendor everything.** Download fonts / libraries into the Deck Source; reference with relative paths.
  - `data:` and `blob:` URLs are OK for images.
- **No runtime API.** There is no `window.deck`. Treat `index.html` as a plain web page.
- **Server binds to `127.0.0.1` only.**
- **Electron settings:** `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.

## 5. Keyboard & pagination

**The Deck App does not implement pagination or define "slide".** That's the author's job, in-page.

Keyboard events are forwarded to the page transparently — listen with standard Web APIs:

```js
window.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight' || e.key === ' ') nextSlide()
  if (e.key === 'ArrowLeft') prevSlide()
})
```

All keys reach the page (arrows, Space, PageUp/Down, letters, …). The only keys the Deck App swallows are container-level shortcuts:

- `Esc` — exit fullscreen / presentation mode.
- `F11` / `Cmd+Ctrl+F` — toggle fullscreen.
- Browser devtools, window controls, OS-level shortcuts.

Authors are free to use any slide framework — reveal.js, Swiper, custom — as long as it's vendored.

## 6. Window drag (`drag` field)

The Player has no titlebar, so drag-to-move is provided by injected CSS. `drag` in `deck.json` picks the strategy.

| Value    | Behavior                                                                                                        |
| -------- | --------------------------------------------------------------------------------------------------------------- |
| `"auto"` | **Default.** `<body>` is a drag region; common interactive elements are carved back out as `no-drag`.           |
| `"off"`  | No drag CSS installed. Author owns drag entirely — use for canvas-based Decks that need every pixel for input.  |

`"auto"` automatically excludes: `<a>`, `<button>`, `<input>`, `<textarea>`, `<select>`, `<label>`, `<video>`, `<audio>`, `<iframe>`, `<embed>`, `<object>`, elements with `role="button|link|textbox|slider|checkbox|radio|menuitem|tab"`, and `contenteditable` elements.

**Author overrides** via the standard `-webkit-app-region` property (leaf wins over ancestor):

```css
.my-clickable-div { -webkit-app-region: no-drag; }  /* opt out of drag */
.my-titlebar      { -webkit-app-region: drag; }     /* opt into drag */
```

**Platform note:** auto CSS is only installed on macOS. Windows/Linux have a native titlebar.

**Common gotcha:** `"auto"` makes most of `<body>` a drag region, which kills text selection on non-interactive elements. Opt specific elements out in CSS:

```css
h1, p, .selectable { -webkit-app-region: no-drag; }
```

Or flip to `"drag": "off"` entirely.

## 7. Versioning

v1 is the only version. There is **no** `spec` or `spec-version` field in `deck.json`. A future v2 would introduce `"spec": "2.0"`; v1 Deck Apps will ignore it and parse as v1.

## 8. Integrity

v1.0 does not specify signing or hashes. A `.deck` is just a zip — anyone with the file can modify it. Don't rely on tamper-resistance; a future version may add signing out-of-band.
