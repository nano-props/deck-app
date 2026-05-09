# Deck Terminology

| Term | Meaning |
| --- | --- |
| **Deck** | A single presentation. Concretely, either a Deck Pack or a Deck Source. |
| **Deck Pack** | A `.deck` file. It is a ZIP archive and is the user-facing file format. |
| **Deck Source** | The unpacked directory containing `deck.json`, `index.html`, and assets. |
| **Deck Manifest** | The `deck.json` file at the Deck Source root. |
| **Deck App** | The desktop application. |
| **Editor** | The Deck App view where AI and authoring tools edit the current Deck Source. |
| **Player** | The Deck App view for presenting or reading the deck. |

## Editor-specific vocabulary

When running inside Deck App Editor:

- "Create a deck" means author the currently-open Deck Source into the requested deck.
- "Save" means rely on Deck App's Save / close flow.
- "Export" or "pack" is not an AI action unless the host app explicitly provides an export tool.

## Anti-patterns in Editor

- Do not create a sibling `<slug>/` directory.
- Do not write `<slug>.deck`.
- Do not tell the user to run `zip`.
- Do not treat the temporary extraction path as a user-facing location.
