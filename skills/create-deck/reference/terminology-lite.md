# Deck Terminology — Lite

> Lite digest of the project's authoritative terminology table. Use these exact terms. Don't invent synonyms.

## Format

| Term              | Meaning                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------- |
| **Deck**          | A single presentation. Concretely: a `.deck` file (Pack) or a directory (Source).         |
| **Deck Pack**     | The packaged `.deck` file — a standard ZIP archive. The user-facing form, both for distribution and for in-app editing. |
| **Deck Source**   | The unpacked directory form. Useful as a working area while authoring; not surfaced as a separate concept in the Deck App UI. |
| **Deck Manifest** | The `deck.json` file at the root.                                                         |
| **pack a Deck**   | Verb. Zip a Deck Source into a Deck Pack.                                                 |
| **unpack a Deck** | Verb. Extract a Deck Pack into a Deck Source.                                             |
| **open a Deck**   | Verb. Load a Deck in the Deck App. Works on either a Deck Pack or a Deck Source.          |

A Deck Source and a Deck Pack have **identical** directory structure — the only difference is whether it has been zipped.

## Application

| Term                  | Meaning                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------- |
| **Deck App**          | The desktop application. Hosts the three views below.                                   |
| **Deck App Launcher** | Initial view when no Deck is loaded. Open recent, create new, browse.                   |
| **Deck App Player**   | The view that hosts a Deck for reading or presenting.                                   |
| **Deck App Editor**   | The view that hosts a Deck for editing: AI chat on the left, live preview right. Works on Pack and Source alike. |

**Key relationships** (relevant when discussing how a user works with a Deck):

- A Deck Pack defaults to opening in the Player; the user can flip to the Editor for any Deck. The Editor's edits to a Pack are flushed back to the original `.deck` on Save / close.
- A Deck Source defaults to opening in the Editor.
- Player and Editor are mutually exclusive — the same Deck is never open in both at once.

## Anti-patterns — don't use

- ~~"deck file"~~ → **Deck Pack**.
- ~~"deck project"~~ → **Deck Source** (for the directory) or **Deck Pack** (for the user's working artifact in the Deck App).
- ~~"workspace"~~ → there is no workspace concept. Pack edits live in a temp extraction the Deck App manages internally; users never see or address it.
- ~~"Reader mode"~~ → **Deck App Player**.
- ~~"landing page"~~ → **Deck App Launcher**.
- ~~"extracted directory"~~ → **Deck Source** (an authoring directory) or "the Pack's live extraction" (the app's internal temp directory).
