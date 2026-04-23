# Deck Terminology — Lite

> Lite digest of the project's authoritative terminology table. Use these exact terms. Don't invent synonyms.

## Format

| Term              | Meaning                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------ |
| **Deck**          | A single presentation (the abstract thing). Concretely: a Deck Pack or a Deck Source.      |
| **Deck Pack**     | The packaged `.deck` file — a standard ZIP archive. Distribution form.                     |
| **Deck Source**   | The unpacked directory form. Contains `deck.json`, `index.html`, and assets. Author form.  |
| **Deck Manifest** | The `deck.json` file at the root.                                                          |
| **pack a Deck**   | Verb. Zip a Deck Source into a Deck Pack.                                                  |
| **unpack a Deck** | Verb. Extract a Deck Pack into a Deck Source.                                              |
| **open a Deck**   | Verb. Load a Deck in the Deck App. Works on either a Deck Pack or a Deck Source.           |

A Deck Source and a Deck Pack have **identical** directory structure — the only difference is whether it has been zipped.

## Application

| Term                  | Meaning                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------- |
| **Deck App**          | The desktop application. Hosts the three views below.                                    |
| **Deck App Launcher** | Initial view when no Deck is loaded. Open recent, create new, browse.                    |
| **Deck App Player**   | The view that hosts a Deck for reading or presenting.                                    |
| **Deck App Editor**   | The view that hosts a Deck Source for editing: AI chat on the left, live preview right.  |

**Key relationships** (relevant when users ask to edit a Deck):

- A Deck Pack opens in the Player only. To edit it, it must first be **unpacked** into a Deck Source.
- A Deck Source can open in either the Player (read/present) or the Editor (edit), but never both at once.

## Anti-patterns — don't use

- ~~"deck file"~~ → **Deck Pack**. "File" is ambiguous (a Deck Source is a directory).
- ~~"deck project"~~ → **Deck Source**.
- ~~"Reader mode"~~ → **Deck App Player**.
- ~~"landing page"~~ → **Deck App Launcher**.
- ~~"extracted directory"~~ → **Deck Source**.
