# Terminology

The fixed vocabulary used in this project. Both the spec ([`deck-spec.md`](./deck-spec.md)) and the product doc ([`deck.md`](./deck.md)) defer to this table. If they disagree, this table wins.

---

## Format

| Term              | Definition                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| **Deck**          | A single presentation. Concretely: a `.deck` file (a Deck Pack), or a directory (a Deck Source).            |
| **Deck Pack**     | A packaged `.deck` file — a standard ZIP archive. The user-facing form, both for distribution and for editing in the Deck App. |
| **Deck Source**   | The unpacked directory form. Used by skills/CLI workflows that author a Deck on disk before zipping. Not surfaced as a separate concept in the Deck App UI. |
| **Deck Manifest** | The `deck.json` file at the root of a Deck Source or Deck Pack.                                             |
| **pack a Deck**   | Verb. Zip a Deck Source into a Deck Pack.                                                                   |
| **unpack a Deck** | Verb. Extract a Deck Pack into a Deck Source.                                                               |
| **open a Deck**   | Verb. Load a Deck in the Deck App; the source may be a Deck Pack or a Deck Source.                          |

A Deck Source and a Deck Pack have **identical** directory structure; the only difference is whether it has been zipped. The Deck App opens either form directly and edits both in place — for a Pack the app extracts internally, edits the extraction, and rezips back into the original `.deck` on Save / close.

> **Pack as the canonical form.** Earlier drafts treated a Pack as the read-only "distribution" form and a Source as the "authoring" form. That distinction is gone. A `.deck` is both. The Deck App's Editor edits Packs directly; users never need to unpack manually. "Deck Source" still exists for skill-/CLI-style workflows that build a Deck on disk and then zip it, but it isn't a concept the app's UI exposes.

---

## Application

| Term                  | Definition                                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Deck App**          | The desktop application itself (an Electron binary). A single binary hosts the three views below.                             |
| **Deck App Launcher** | The initial view shown when the Deck App has started but no Deck is loaded. Responsible for: open recent, create new, browse. |
| **Deck App Player**   | The view that hosts a Deck for reading or presenting. The "open flow" described in spec §3 is the Player's startup flow.      |
| **Deck App Editor**   | The view that hosts a Deck for editing: AI chat on the left, live preview on the right. Works on Pack and Source alike. See [`deck.md` §5](./deck.md). |

### Relationship between Launcher, Player, and Editor

- At any moment a given Deck lives in at most one view. Player and Editor are mutually exclusive — the same Deck is never open in both at once.
- The Launcher does not host a Deck; it is only a starting point.
- From the Launcher: a Deck Pack defaults to the Player (it's a finished artifact — the user usually opens to view); a Deck Source defaults to the Editor. Either can be flipped after open.
- The Player has an entry point to switch to the Editor for any loaded Deck. Packs are no longer barred — the Editor's edits to a Pack are flushed back to the original `.deck` on Save / close.
- Closing the last view returns to the Launcher, or quits per platform convention.

> In sufficiently clear context the short forms Launcher / Player / Editor are fine. Use the full names in formal descriptions and cross-section references.

---

## Anti-patterns: don't use these

- ~~"deck file"~~ → say **Deck Pack**. "File" is ambiguous on its own.
- ~~"deck project"~~ → say **Deck Source** (for the directory authoring form) or **Deck Pack** (for the user's working artifact in the Deck App).
- ~~"workspace"~~ → there is no workspace concept anymore. Edits to a Pack happen in a temporary extraction the Deck App manages internally; users don't see or address it.
- ~~"Reader mode"~~ → say **Deck App Player**. It is a named view, not a "mode".
- ~~"landing page"~~ → say **Deck App Launcher**.
- ~~"extracted directory"~~ → say **Deck Source** for an authoring directory; say "the Pack's live extraction" for the app's internal temp directory.

> **Inside the AI editing context, "Deck Source" is overloaded by design.** The Editor's AI session and its tools (see `src/main/ai/session/system-prompt.ts` and `src/main/ai/tools.ts`) refer to the AI's working root as the "Deck Source" regardless of whether the Deck was opened as a Pack (a fresh temp extraction) or as a real folder. The two cases are functionally identical from the AI's vantage point — same sandbox, same tools, same `rootDir` semantics — and giving them different names in the prompt would leak an irrelevant distinction into the model. The system prompt separately reminds the model that *Pack Decks are extracted to a fresh temp directory each time they are opened*, which is the only ephemerality fact the AI needs. The "live extraction" phrasing above remains the right term in human-facing docs that discuss the implementation; the AI-facing surface uses "Deck Source" uniformly.
