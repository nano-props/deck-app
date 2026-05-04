# Deck

Desktop container for `.deck` presentations — a `.deck` is just a zipped static website.

- **Spec:** [`docs/deck-spec.md`](./docs/deck-spec.md)
- **Product doc:** [`docs/deck.md`](./docs/deck.md)
- **Terminology:** [`docs/terminology.md`](./docs/terminology.md)

## Authoring a Deck

See the skill at [`skills/create-deck/`](./skills/create-deck/) for a step-by-step authoring guide, and [`skills/create-deck/reference/spec-lite.md`](./skills/create-deck/reference/spec-lite.md) for a lite, author-oriented digest of the spec.

## Dev

```
bun install
bun run dev
```

Implementation design docs (read when hacking on the Deck App itself, not when authoring Decks):

- [`docs/window-chrome.md`](./docs/window-chrome.md) — per-platform titlebar, drag, and traffic light behavior.

## Install

```
./install.sh                 # shorthand for `bun run build:app install`
bun run build:app install    # build + move Deck.app into ~/Applications
bun run build:app            # build only → release/mac-<arch>/Deck.app
bun run build:app win        # build Windows portable → release/Deck-<version>-portable.exe
```

## Sample decks

`scripts/pack-deck.ts <name>` reads `examples/<name>/` and writes `examples/<name>.deck`. `examples/` is gitignored, so sample sources aren't checked in — create one locally with a `deck.json` + `index.html` before running `bun run pack:deck <name>`.
