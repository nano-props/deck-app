# Skills

Agent skills shipped with the Deck App. Each skill is a self-contained folder — `SKILL.md` plus its own references and templates — that an AI agent loads on demand.

## Design intent

Skills here are **independently distributable**. The Deck App ships as a binary to users who don't clone this repo, and a skill must work the same whether it sits in this repo or is copied into `~/.claude/skills/` next to an installed Deck App.

Concretely, each skill:

- References nothing outside its own folder — no `docs/`, `scripts/`, or `bun run ...` commands.
- Relies only on tools a user already has (system `zip`, `unzip`, a text editor).
- Ships its own `-lite` digests of authoritative docs under `/docs`. Lite files are curated subsets for authors, not mirrors — the `/docs` originals remain the source of truth.

Dropping the folder into any `skills/` directory Just Works.

## Skills

### `create-deck/`

Creates a Deck — a `.deck` presentation file or unpacked Deck Source directory. Triggers on "create a deck", "make a presentation", "build slides". Packs with system `zip`; no runtime dependencies.

```
create-deck/
├── SKILL.md
├── reference/
│   ├── spec-lite.md              # digest of /docs/deck-spec.md
│   └── terminology-lite.md       # digest of /docs/terminology.md
└── templates/
    ├── deck.json
    └── index.html
```

### `deck-design/`

Guides the visual design of a Deck — typography, color, motion, spatial composition, and the deck-specific constraints that follow from the medium (live presenting + solo reading, keyboard pagination, CSP sandbox, no hover-hidden content). Pairs with `create-deck/`, which handles the format and packaging.

```
deck-design/
└── SKILL.md
```

## Maintaining

When `/docs` changes in a way that affects authoring, re-read the authoritative doc and update the corresponding `-lite` file. Don't mechanically diff — decide what an author needs to know.

If you find yourself adding a repo-internal path or `bun run ...` command to a `SKILL.md`, the skill is leaking repo assumptions. Push that dependency into the skill folder instead.
