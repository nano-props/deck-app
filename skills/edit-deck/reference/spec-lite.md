> This is a lite, author-oriented digest of the Deck v1.0 specification, scoped to what you need when editing a Deck Source inside Deck App Editor.

# Deck v1 Authoring Rules

## 1. Files

A Deck Source is a static website directory containing, at its root:

```
deck.json
index.html
```

Additional files may be placed anywhere under the same directory and referenced with relative paths.

## 2. Manifest

`deck.json` is JSON. Only `name` is required:

```json
{
  "name": "My Deck"
}
```

Optional author-facing fields include:

- `author`
- `description`
- `cover`
- `version`

Unknown fields are ignored for forward compatibility. There is no spec-version field in v1.

## 3. Entry point

`index.html` is the only required entry point. It is served from the Deck Source root.

## 4. Runtime sandbox

Deck content runs as a local static page with a strict Content Security Policy. Author as if these are blocked:

- remote scripts
- remote stylesheets
- remote images
- remote fonts
- third-party `fetch()`
- CDN dependencies

Use inline code or vendored local files. `data:` and `blob:` URLs are acceptable for images where appropriate.

## 5. No runtime API

There is no `window.deck` API. Treat `index.html` as a plain web page.

## 6. Slides and keyboard behavior

The Deck App does not understand slide boundaries. Pagination, slide counters, transitions, and keyboard navigation belong to the authored page.

Avoid shortcuts that conflict with the container:

- `Esc`
- `F11`
- `Cmd+Ctrl+F`
- `Cmd` / `Ctrl` menu shortcuts such as save, reload, close, open, and settings

Plain keys such as ArrowLeft, ArrowRight, Space, PageUp, PageDown, Home, End, and letters generally reach the page.

## 7. Editor saving

Inside Deck App Editor, edits are made to the current Deck Source. If the user opened a Deck Pack (`.deck`), the app flushes the edited Source back to that original pack on Save / close. Do not pack, zip, or write a separate `.deck` file from the AI.
