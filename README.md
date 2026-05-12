# Deck

Desktop presentation tool for the AI era. A `.deck` is a zipped static website — open it to play, edit it with AI, or share it as a single file.

## Develop

```bash
bun install
bun run dev
```

Install locally:

```bash
./install.sh
```

## Authoring

- In the app: `File → New Deck…` (`⌘N`)
- With an external agent: use the [`skills/create-deck/`](./skills/create-deck/) skill

Agent skills under [`skills/`](./skills/):

| Skill | Purpose |
|-------|---------|
| `create-deck` | Create a `.deck` pack externally |
| `edit-deck` | Guide the Editor's built-in AI |
| `deck-design` | Visual design guidance |

## Documentation

- [`docs/deck.md`](./docs/deck.md) — product doc, architecture, design decisions
- [`docs/deck-spec.md`](./docs/deck-spec.md) — `.deck` format spec
- [`docs/terminology.md`](./docs/terminology.md) — project vocabulary
- [`docs/window-chrome.md`](./docs/window-chrome.md) — platform titlebar behavior
