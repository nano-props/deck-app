> Lite digest of the project's authoritative terminology table, scoped to what Deck AI needs while editing inside Deck App Editor. Use these exact terms; don't invent synonyms.

# Deck Terminology — Editor

## Format

| Term              | Meaning                                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Deck**          | A single presentation. Concretely: a `.deck` file (Pack) or a directory (Source).                                                      |
| **Deck Pack**     | The packaged `.deck` file — a standard ZIP archive. The user-facing form, both for distribution and for in-app editing.                |
| **Deck Source**   | The unpacked directory form. Inside the Deck App UI, only Packs are surfaced; the Deck Source concept survives for skill/CLI workflows. |
| **Deck Manifest** | The `deck.json` file at the root.                                                                                                      |
| **pack a Deck**   | Verb. Zip a Deck Source into a Deck Pack.                                                                                              |
| **unpack a Deck** | Verb. Extract a Deck Pack into a Deck Source.                                                                                          |
| **open a Deck**   | Verb. Load a Deck in the Deck App. Works on either a Deck Pack or a Deck Source.                                                       |

A Deck Source and a Deck Pack have **identical** directory structure — the only difference is whether it has been zipped.

> **"Deck Source" in your editing context is overloaded by design.** Your working root — what the system prompt calls *the Deck Source* — is a real folder if the user opened a Source, or the Pack's live temp extraction if they opened a `.deck`. The two cases are functionally identical for you: same sandbox, same tools, same `rootDir`. The only fact you need beyond that is the one the system prompt already gives you: Pack extractions are fresh per open, so don't reuse absolute paths from earlier chats. The Deck App handles flushing edits back to the original `.deck` on Save / close.

## Application

| Term                  | Meaning                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| **Deck App**          | The desktop application. Hosts the three views below.                                                    |
| **Deck App Launcher** | Initial view when no Deck is loaded. Open recent, create new, browse.                                    |
| **Deck App Player**   | The view that hosts a Deck for reading or presenting.                                                    |
| **Deck App Editor**   | The view that hosts a Deck for editing: AI chat on the left, live preview on the right. This is you.     |

A Pack defaults to opening in the Player; users flip to the Editor on demand. A Source defaults to opening in the Editor. Player and Editor are mutually exclusive — the same Deck is never open in both at once. Your edits to a Pack are flushed back to the original `.deck` on Save / close.

## Editor-mode rules

- "Create a deck" / "build a deck" means **author the currently-open Deck in place**. You already have one open.
- "Save" / "Export" is not an AI action. The Deck App owns Save / close and writes back to the opened `.deck`.
- Don't create a sibling `<slug>/` directory. Don't write a `<slug>.deck`. Don't tell the user to run `zip`.
- Don't surface the temp extraction path as a user-facing location. The user thinks of their Deck as the `.deck` they opened.

## Anti-patterns

- ~~"deck file"~~ → **Deck Pack**.
- ~~"deck project"~~ → **Deck Pack** (what the user works with) or **Deck Source** (the directory form, when relevant).
- ~~"workspace"~~ → there is no workspace concept. Pack edits live in a temp extraction the Deck App manages internally; users never see or address it.
- ~~"Reader mode"~~ → **Deck App Player**.
- ~~"landing page"~~ → **Deck App Launcher**.
- ~~"extracted directory"~~ / ~~"temp folder"~~ → **Deck Source**. Your working root is always called the Deck Source, regardless of whether the user opened a Pack or a Source (see the callout above).
