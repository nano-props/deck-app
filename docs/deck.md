# Deck App — Product Doc

> Terminology follows [`terminology.md`](./terminology.md): **Deck**, **Deck Pack**, **Deck Source**, **Deck Manifest**, **Deck App**, **Deck App Launcher**, **Deck App Player**, **Deck App Editor**. Format details live in [`deck-spec.md`](./deck-spec.md). This document covers the Deck App software itself.

> **Status.** The current codebase ships the Launcher and the Player against the v1.0 spec. The Editor described in §5 is planned, not implemented. Sections describing unshipped features are marked _(planned)_.

---

## 1. Positioning

**Deck App** is a desktop presentation tool for the AI era, built on Electron. It redefines a "slide deck" as:

> A distributable, interactive mini static website — and the Deck App is its native container (play + edit).

---

## 2. Product shape

One Electron binary, three views:

- **Launcher** — the entry view; open recent, create new, browse for a Deck.
- **Player** — opens a Deck for reading and presenting.
- **Editor** _(planned)_ — opens a Deck Source for editing: AI chat on the left, live preview on the right, export to Deck Pack.

### Entry points

- Double-click a `.deck` → Player.
- Open a folder → Player (and in the future, Editor) — Deck Source supports both.
- Launch from Dock / menu / CLI with no arguments → Launcher.
- From the Player, _"Open in Editor"_ → switch to the Editor _(planned; Deck Pack must be unpacked first)_.

---

## 3. Tech stack

| Layer                     | Current                      | Planned                                                                          |
| ------------------------- | ---------------------------- | -------------------------------------------------------------------------------- |
| App framework             | Electron (main + renderer)   | —                                                                                |
| Language                  | TypeScript                   | —                                                                                |
| Package manager / scripts | Bun (dev only)               | —                                                                                |
| Runtime                   | Electron's bundled Node      | —                                                                                |
| Launcher UI               | Plain HTML / CSS / TS        | React + Vite + shadcn/ui + Tailwind                                              |
| State                     | —                            | Zustand (sliced per view; `persist` → JSON)                                      |
| Local HTTP server         | Node `http` + `serve-static` | `fastify` + `@fastify/static`                                                    |
| Zip                       | `adm-zip`                    | `yauzl` / `yazl`                                                                 |
| File watcher              | —                            | `chokidar` (Editor dev server)                                                   |
| AI                        | —                            | `@anthropic-ai/sdk` with prompt caching; requests proxied by the main process    |
| Persistence               | —                            | JSON + JSONL under `app.getPath('userData')`; secrets via OS Keychain (`keytar`) |

### Local server lifecycle

- Opening a Deck starts a new server on `127.0.0.1` at a random port (`port: 0`).
- Closing the window runs `server.close()`; if the source was a Deck Pack, the temp extraction directory is also deleted.
- On startup the app sweeps leftover extracted decks from previous crashes under `os.tmpdir()/deck-app/*`. Entries are only deleted if their mtime predates the current process start — so a concurrent sibling process cannot be clobbered (defense in depth; the single-instance lock already prevents siblings).
- Editor mode _(planned)_: `chokidar` watches the Deck Source and pushes reload events to the preview iframe over WebSocket.

### Persistence layout _(planned)_

```
userData/
├── settings.json          # theme, model, shortcuts, API-key reference
├── recents.json           # recently opened Decks
├── projects/<id>.json     # per-project edit metadata
├── chats/<id>.jsonl       # AI chat history (append-only)
└── logs/<id>.jsonl        # AI tool-call logs (optional)
```

- JSON files: atomic write (tmp + rename), debounced dirty flag.
- JSONL files: `fs.createWriteStream({ flags: 'a' })`; auto-rotate past 10 MB.

---

## 4. Player

### 4.1 Startup flow

See [`deck-spec.md` §3](./deck-spec.md). The Player supports both Deck Pack (extracted into a temp directory, then hosted) and Deck Source (directory hosted as-is).

### 4.2 Window chrome

The Player is a minimal shell. On macOS the window uses `titleBarStyle: 'hidden'` and the traffic lights are hidden — the author's content fills the whole window. A 12px invisible drag strip is injected along the top so the window remains movable; it uses `pointer-events: none`, so any author UI in the top 12px stays fully interactive.

_Planned UI additions:_

- Fullscreen / presentation toggle button.
- Export / share.
- "Open in Editor" entry point.

**Presentation mode** _(planned)_: hide all chrome, content-only fullscreen.

**Container-level shortcuts** (handled by the Deck App; not forwarded to the page): `Esc` exits fullscreen · `F11` / `Cmd+Ctrl+F` toggles fullscreen · `Cmd+W` closes on macOS (via Electron's `close` role).

### 4.3 Keyboard events

Rules: see [`deck-spec.md` §5](./deck-spec.md). Apart from container-level shortcuts, every key is forwarded to the page. The Player **never swallows arrow keys, Space, PageUp/Down, etc.** that a page might use, and **never injects a `window.deck` runtime API** — the author's window stays a plain web page.

### 4.4 Cleanup

When a window closes: the server stops; if the source was a Deck Pack, the temp extraction directory is deleted; if the source was a Deck Source, the user's directory is left untouched.

### 4.5 Security

See [`deck-spec.md` §4](./deck-spec.md). The CSP is set on every HTTP response by the per-deck server, and window webPreferences are locked down (`contextIsolation`, `sandbox`, no `nodeIntegration`).

---

## 5. Editor _(planned)_

### 5.1 Layout

Inspired by pencil.dev / Cursor / v0.dev:

```
┌───────────────────────────┬────────────────────────────┐
│  AI chat / commands (35%) │  Live preview iframe (65%) │
│  · message history        │  · preview of current Deck │
│  · input + send           │  · device-size toggle      │
│  · attachments            │  · refresh / DevTools      │
│  · model picker           │  · source / preview toggle │
└───────────────────────────┴────────────────────────────┘
Top bar: project name · save state · export · settings
```

### 5.2 How it works

- Each editable Deck is backed by a **Deck Source** on disk (unpacked).
- The Editor runs a dev server against that directory; `chokidar` watches for changes and hot-reloads the iframe.
- The AI acts as a "file editor" — reading and writing files inside the Deck Source.
- Export = _pack a Deck_: zip the Deck Source into a Deck Pack.

### 5.3 AI capabilities

- **Conversational generation**: _"Make a 10-slide deck about Transformers"_, _"Change slide 3 to a dark theme"_.
- **Tool use** (Claude Code-style): `read_file` / `write_file` / `list_dir` / `add_asset`.
- **Context**: the current page plus related files by default; prompt caching holds the system prompt and project skeleton warm.
- **Models**: Claude Sonnet 4.6 by default; switch to Opus 4.7 for complex refactors.

> The AI writes HTML / CSS / JS directly — it does not manipulate a structured slide model. Freedom equals plain web development. The _"works out of the box"_ responsibility lives in **templates** (see 5.4), not in the spec or runtime.

### 5.4 Templates

Every starter template is itself a minimal Deck; the AI edits on top. Each template contains a `deck.json` (with `name` only), an `index.html` (with arrow-key pagination and a `.slide` layout preset), and baseline CSS.

Initial template lineup: Minimal White / Tech Dark / Academic Paper / Keynote / Scrolling Longform.

### 5.5 Asset management

Drag an image / video / font into the window to add it to the Deck Source (recommended under `assets/`, not enforced). The AI sees the asset listing and references those files in its code.

### 5.6 Export

- **Deck Pack** (`.deck`) — the primary output; zip the entire Deck Source.
- **HTML directory** — emit the static site as-is.
- **PDF** — Electron `printToPDF` _(later)_.
- **MP4** — headless recording _(long-term)_.

---

## 6. Menu

**Currently shipped:**

- **File** — Open .deck… (`Cmd+O`) · Open Folder… (`Cmd+Shift+O`) · Close (macOS) / Quit.
- **View** — Reload · Force Reload · Toggle DevTools · Toggle Fullscreen.

**Planned:**

- **File** — add _New_, _Open Recent_, _Save_, _Export_.
- **Edit** — Undo / Redo / Find.
- **AI** — model picker, clear chat, export chat.
- **Help** — shortcuts, updates, about.

---

## 7. Key design decisions

- **Separate spec from implementation.** The spec is minimal (zip + `deck.json` + `index.html`); rich capabilities live in the app layer.
- **No slide model.** The spec does not define "page", and the Deck App does not own pagination. Any web code runs — maximum freedom. The _"out-of-the-box pagination"_ responsibility lives in templates, not in the spec or runtime.
- **Player and Editor fused.** One binary, one shared core — distribution and mental model stay intact.
- **AI writes code, not a structured model.** Higher ceiling; this is what Claude does best. The floor is held by templates.
- **Local-first.** No required login, no cloud round-trip. User files stay on the user's machine. This is the structural difference from Gamma / Tome and other SaaS competitors.

---

## 8. Competitive landscape

| Dimension                                | Gamma / Tome | Keynote / PPT    | reveal.js | **Deck App** |
| ---------------------------------------- | ------------ | ---------------- | --------- | ------------ |
| AI-native                                | ✓            | ✗                | ✗         | ✓            |
| Local-first                              | ✗            | ✓                | ✓         | ✓            |
| Open format                              | ✗            | △                | ✓         | ✓            |
| Native container                         | browser      | Office / Keynote | browser   | **Deck App** |
| Double-click to open                     | ✗            | ✓                | ✗         | ✓            |
| Expressive power (interactivity / WebGL) | low          | low              | high      | high         |

One-line positioning: **reveal.js's expressiveness + PDF's distribution simplicity + PowerPoint's double-click-to-open, packaged into an AI-native desktop app.**
