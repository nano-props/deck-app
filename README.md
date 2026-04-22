# Deck

Desktop container for `.deck` presentations — a `.deck` is just a zipped static website.

- **Spec:** [`docs/deck-spec.md`](./docs/deck-spec.md)
- **Product doc:** [`docs/deck.md`](./docs/deck.md)
- **Terminology:** [`docs/terminology.md`](./docs/terminology.md)

## Dev

```
bun install
bun run dev
```

## Install

```
./install.sh                 # shorthand for `bun run build:app install`
bun run build:app install    # build + move Deck.app into ~/Applications
bun run build:app            # build only → release/mac-<arch>/Deck.app
```

## Sample decks

`scripts/pack-deck.ts <name>` reads `examples/<name>/` and writes `examples/<name>.deck`. `examples/` is gitignored, so sample sources aren't checked in — create one locally with a `deck.json` + `index.html` before running `bun run pack:deck <name>`.
