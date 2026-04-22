# Terminology

The fixed vocabulary used in this project. Both the spec ([`deck-spec.md`](./deck-spec.md)) and the product doc ([`deck.md`](./deck.md)) defer to this table. If they disagree, this table wins.

---

## Format

| Term              | Definition                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| **Deck**          | The abstract concept of a single presentation. Concretely it exists as either a Deck Pack or a Deck Source. |
| **Deck Pack**     | A packaged `.deck` file — a standard ZIP archive. The distribution form.                                    |
| **Deck Source**   | The unpacked directory form, containing `deck.json`, `index.html`, and any assets. The authoring form.      |
| **Deck Manifest** | The `deck.json` file at the root of a Deck Source or Deck Pack.                                             |
| **pack a Deck**   | Verb. Zip a Deck Source into a Deck Pack.                                                                   |
| **unpack a Deck** | Verb. Extract a Deck Pack into a Deck Source.                                                               |
| **open a Deck**   | Verb. Load a Deck in the Deck App; the source may be a Deck Pack or a Deck Source.                          |

A Deck Source and a Deck Pack have **identical** directory structure; the only difference is whether it has been zipped. The Deck App opens either form directly.

---

## Application

| Term                  | Definition                                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Deck App**          | The desktop application itself (an Electron binary). A single binary hosts the three views below.                             |
| **Deck App Launcher** | The initial view shown when the Deck App has started but no Deck is loaded. Responsible for: open recent, create new, browse. |
| **Deck App Player**   | The view that hosts a Deck for reading or presenting. The "open flow" described in spec §3 is the Player's startup flow.      |
| **Deck App Editor**   | The view that hosts a Deck Source for editing: AI chat on the left, live preview on the right. See [`deck.md` §5](./deck.md). |

### Relationship between Launcher, Player, and Editor

- At any moment a given Deck lives in at most one view. Player and Editor are mutually exclusive — the same Deck is never open in both at once.
- The Launcher does not host a Deck; it is only a starting point.
- From the Launcher: a Deck Pack opens into the Player; a Deck Source opens into either the Player or the Editor.
- The Player has an entry point to switch to the Editor — but only when the source is a Deck Source. A Deck Pack must be explicitly unpacked into a Deck Source first.
- Closing the last view returns to the Launcher, or quits per platform convention.

> In sufficiently clear context the short forms Launcher / Player / Editor are fine. Use the full names in formal descriptions and cross-section references.

---

## Anti-patterns: don't use these

- ~~"deck file"~~ → say **Deck Pack**. "File" is ambiguous (a Deck Source is a directory, not a file).
- ~~"deck project"~~ → say **Deck Source**.
- ~~"Reader mode"~~ → say **Deck App Player**. It is a named view, not a "mode".
- ~~"landing page"~~ → say **Deck App Launcher**.
- ~~"extracted directory"~~ → say **Deck Source**. For the Deck App's internal temp extraction, say "temporary working directory".
