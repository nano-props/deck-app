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
  "version": "1.0.0"          // SemVer, author-maintained
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

## 6. Window drag

The Player uses a platform-appropriate window chrome: traffic lights at top-left on macOS, native caption buttons at top-right on Windows/Linux. Scrolling, hover, pointer events, and text selection work normally in the rest of the page.

**Top 32px of the author page is reserved (all platforms).** On macOS the Deck App injects a transparent drag strip there so the window stays draggable even when the Deck has a header pinned to `top: 0`. The strip is invisible but swallows clicks. Windows/Linux don't inject a strip (caption buttons / native titlebar already sit above web contents), but the same 32px reservation applies.

**Authoring rules for the top 32px:**

- **No clickable controls** (buttons, links, inputs) — they won't receive clicks, hover, or pointer events. Inset headers/nav bars by 32px, or position interactive elements below the strip.
- **No logos or important visuals in the top-left or top-right ~80×32px** — on macOS the traffic lights sit at the top-left; on Windows the caption buttons sit at the top-right. Both cover anything underneath. The 32px reservation is a cross-platform rule.

If an author wants extra drag zones elsewhere (e.g. a custom header bar **below** the reserved strip), they can opt in with standard CSS — make sure it's positioned below 32px so it doesn't fight the strip:

```css
.my-header-bar {
  position: fixed;
  top: 32px; /* sit below the reserved strip */
  left: 0;
  right: 0;
  height: 40px;
  -webkit-app-region: drag;
}
```

Don't mark `<body>` or large regions as drag — doing so swallows wheel and pointer events on everything underneath.

## 7. Versioning

v1 is the only version. There is **no** `spec` or `spec-version` field in `deck.json`. A future v2 would introduce `"spec": "2.0"`; v1 Deck Apps will ignore it and parse as v1.

## 8. Integrity

v1.0 does not specify signing or hashes. A `.deck` is just a zip — anyone with the file can modify it. Don't rely on tamper-resistance; a future version may add signing out-of-band.
