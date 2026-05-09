# Deck App — Product Doc

> Terminology follows [`terminology.md`](./terminology.md): **Deck**, **Deck Pack**, **Deck Source**, **Deck Manifest**, **Deck App**, **Deck App Launcher**, **Deck App Player**, **Deck App Editor**. Format details live in [`deck-spec.md`](./deck-spec.md). This document covers the Deck App software itself.

> **Status.** The current codebase ships all three views — Launcher, Player, and Editor — against the v1.0 spec. The Editor includes the AI chat panel, `chokidar` file watcher with auto-reload, and the sandboxed file-editor tool set described in §5. Sections describing unshipped features are marked _(planned)_.

---

## 1. Positioning

**Deck App** is a desktop presentation tool for the AI era, built on Electron. It redefines a "slide deck" as:

> A distributable, interactive mini static website — and the Deck App is its native container (play + edit).

---

## 2. Product shape

One Electron binary, three views, **one window** (see §4.1):

- **Launcher** — the entry view; open recent, create new, browse for a Deck.
- **Player** — shows a Deck full-bleed below the persistent topbar, for reading and presenting.
- **Editor** — AI chat on the left, live preview on the right (a native `WebContentsView`, not an iframe). Edits to a Pack are flushed back to the original `.deck` file on Save / close.

### Entry points

- Double-click a `.deck` → opens in Player mode. `⌘E` flips to Editor; the deck server and AI session stay live across the flip.
- `File → Open Folder…` (`⌘⇧O`) on a directory containing `deck.json` → opens in Editor mode (developer-friendly path; UI doesn't surface "Source" as a user concept).
- `File → New Deck…` (`⌘N`) → scaffolds a directory from the minimal template and opens it in Editor mode.
- Launch from Dock / menu / CLI with no arguments → Launcher.
- Inside a window hosting a Deck, `⌘E` (Edit Deck) and `⌘⌥P` (Play Deck) flip between the two sub-views. Packs and directories are both editable; the difference is the save model — a Pack rezips back to its `.deck` on `⌘S` / close, a directory writes through.

---

## 3. Tech stack

| Layer                     | Current                                                                                                           | Planned                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| App framework             | Electron (main + renderer)                                                                                        | —                             |
| Language                  | TypeScript                                                                                                        | —                             |
| Package manager / scripts | Bun (dev only)                                                                                                    | —                             |
| Runtime                   | Electron's bundled Node                                                                                           | —                             |
| Renderer UI               | React 19 + Vite + Tailwind v4 + Radix primitives                                                                  | —                             |
| State                     | Zustand stores under `src/renderer/stores/` (one slice per concern: app / chat / ai / attachments / theme / i18n) | —                             |
| Local HTTP server         | Node `http` + `serve-static`                                                                                      | `fastify` + `@fastify/static` |
| Zip                       | `adm-zip`                                                                                                         | `yauzl` / `yazl`              |
| File watcher              | `chokidar` (Editor auto-reload)                                                                                   | —                             |
| AI SDK                    | `@earendil-works/pi-ai` + `pi-agent-core` + `pi-coding-agent`                                                       | —                             |
| Persistence               | JSON + JSONL under `app.getPath('userData')`; API keys via `safeStorage`                                          | —                             |

### Local server lifecycle

- Opening a Deck starts a new server on `127.0.0.1` at a random port (`port: 0`).
- Closing the window (or closing the Deck back to the Launcher) runs `server.close()`. For a Pack: if there are unsaved edits the live extraction is rezipped back into the original `.deck` first (best-effort — failure is logged but doesn't block teardown), then the temp extraction is deleted. For a Source: the directory is left untouched.
- On startup the app sweeps leftover extracted Packs from previous crashes under `os.tmpdir()/deck-app/*`. Entries are only deleted if their mtime predates the current process start — so a concurrent sibling process cannot be clobbered (defense in depth; the single-instance lock already prevents siblings).
- Editor mode: `chokidar` watches the deck root (debounced ~120ms, dotfiles / `node_modules` / common lock files ignored). Change events fire into the main process, which marks the deck dirty (Pack-only — Source writes are already on disk) and calls `webContents.reload()` on the deck `WebContentsView`. No WebSocket — the reload is a native in-process call.

### Persistence layout

All paths are under `app.getPath('userData')`:

```
userData/
├── settings.json             # AI provider choice, per-provider model, custom-endpoint configs, thinking level, compaction thresholds, UI language
├── secrets.json              # API keys, encrypted via Electron safeStorage (OS keychain / DPAPI / secret-service)
├── recents.json              # MRU list of recently opened Decks (max 10)
└── chats/                    # AI session transcripts
    └── <deckId>/             #   deckId = 16-char SHA-256 prefix of canonical sourcePath
        └── <timestamp>_<sid>.jsonl
```

- `settings.json`, `secrets.json`, `recents.json`: plain JSON, rewritten on change. API keys in `secrets.json` are base64 ciphertext produced by `safeStorage.encryptString` — the app refuses to store plaintext when the OS keychain is unavailable. **Theme is intentionally NOT in `settings.json`**: it lives in the renderer's `localStorage` under `deck:theme`, because an inline boot script in `index.html` has to resolve it before any IPC round-trip to avoid a white→dark flash on app launch.
- `chats/<deckId>/<…>.jsonl`: append-only session log managed by `@earendil-works/pi-coding-agent`'s `SessionManager`. The `deckId` hashes the deck's user-facing identity (the `.deck` file path or the directory the user opened), NOT the temp-extraction `rootDir` — a Pack's rootDir is a fresh tmpdir on every open and would split the chat history across opens otherwise. Resuming the most recent session for a deck continues it; starting fresh creates a new file.
- There is no longer a `workspaces/` directory. Pack edits live in `os.tmpdir()/deck-app/<uuid>/` for the lifetime of the open and are removed after the close-time rezip.

---

## 4. Window model & Player

### 4.1 Single-window architecture

The Deck App runs as one `BaseWindow` per open deck (plus one Launcher-only window when no deck is loaded), hosting multiple `WebContentsView`s:

- **`chromeView`** — always mounted. Loads the Vite-built renderer bundle (`dist/renderer/index.html`) and draws the 32px persistent topbar plus the mode-specific body: Launcher landing page, Editor split pane, or nothing (Player mode leaves its body row empty so the deck shines through).
- **`deckView`** — created when a Deck is loaded, destroyed when it's closed. Points at the per-deck local server URL. Runs with `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, and no preload — the author page gets no `window.deck` global and no privileged IPC channel.

The two views are siblings under the window's `contentView`. In **Player** mode the `deckView` is positioned to cover the body below the 32px topbar; in **Editor** mode it's positioned over the right ("preview") pane of the split layout; in **Launcher** mode it isn't mounted at all. The chromeView topbar stays mounted in every mode so the user always has a visible way back to the Launcher.

A window-registry (`src/main/window-registry.ts`) keyed by canonical Deck rootDir enforces the spec-level invariant that the same Deck is never open twice — opening an already-open Deck raises the existing window instead of creating a new one.

### 4.2 Startup flow

See [`deck-spec.md` §3](./deck-spec.md). The Player supports both Deck Pack (extracted into a temp directory, then hosted) and Deck Source (directory hosted as-is).

### 4.3 Window chrome

Platform-appropriate chrome backs a single topbar shared by all three modes. Full per-platform rationale — macOS `hiddenInset` with centered traffic lights, Windows / Linux `titleBarOverlay`, why we no longer inject a drag strip — lives in [`window-chrome.md`](./window-chrome.md). For the author-facing contract (top 32px reserved, no clicks / no important visuals there), see [`deck-spec.md` §6](./deck-spec.md).

**Container-level shortcuts** (handled by the Deck App; never forwarded to the deck page): `Esc` exits fullscreen · `F11` / `Cmd+Ctrl+F` toggles fullscreen · `Cmd+W` / `Ctrl+W` closes the window · `Cmd+Shift+W` / `Ctrl+Shift+W` closes just the Deck and returns to the Launcher · `Cmd+R` / `Ctrl+R` reloads the deck preview (never the chrome — would lose in-flight AI state) · `Cmd+E` / `Ctrl+E` switches to Editor, `Cmd+Alt+P` / `Ctrl+Alt+P` switches to Player. `Cmd+,` / `Ctrl+,` opens the in-window Settings overlay.

**Presentation mode** _(planned)_: hide the topbar and let `deckView` take the full window.

### 4.4 Keyboard events

Rules: see [`deck-spec.md` §5](./deck-spec.md). Apart from the container-level shortcuts listed above, every key is forwarded to the deck page. The Player **never swallows arrow keys, Space, PageUp/Down, etc.** that a page might use, and **never injects a `window.deck` runtime API** — the author's window stays a plain web page.

### 4.5 Cleanup

When the Deck is closed (or the window closed): the deck server stops; any `chokidar` watcher is torn down; for a Pack, if there are unsaved edits we rezip the live extraction back into the original `.deck` (best-effort; teardown continues on failure) and then delete the temp extraction. Source directories the user opened from disk are left untouched.

### 4.6 Security

See [`deck-spec.md` §4](./deck-spec.md). The CSP is set on every HTTP response by the per-deck server, and `deckView` webPreferences are locked down (`contextIsolation`, `sandbox`, no `nodeIntegration`, no preload). The `chromeView` — which does need IPC for AI and settings — runs with `contextIsolation: true` and a narrow preload that only exposes the IPC surface the renderer actually uses.

---

## 5. Editor

### 5.1 Layout

Inspired by pencil.dev / Cursor / v0.dev:

```
┌───────────────────────────┬────────────────────────────┐
│  AI chat (left pane)      │  Live deck preview (right) │
│  · message history        │  · native WebContentsView  │
│  · composer + Send/Stop   │  · auto-reload on change   │
│  · staged attachments     │  · reload button in topbar │
│                           │                            │
└──┬────────────────────────┴────────────────────────────┘
   └── draggable divider (clamped 280px chat / 320px preview min)
Topbar (persistent, 32px): mode toggle · deck name · export · reload · settings
```

The left/right split is driven by real geometry. `TOPBAR_PX = 32` lives in `src/main/window-layout.ts` (the only main-side layout constant); the splitter width and chat-pane min/default sizes (`MIN_CHAT = 280`, `MIN_PREVIEW = 320`, `DIVIDER = 1`, default ≈ 532px) live in `src/renderer/components/Editor.tsx` because they're CSS-grid concerns. The preview is a native `WebContentsView`, not an iframe — the divider drag uses a DOM overlay that reaches leftward into the chat pane only, because the native view would swallow pointer events on its side.

### 5.2 How it works

- Every loaded Deck is editable. The Editor's rootDir is whichever directory the local HTTP server is hosting: a user-owned directory for "Open Folder" / "New Deck", or a per-open temp extraction under `os.tmpdir()/deck-app/<uuid>/` for a `.deck` file.
- The Editor serves that directory over the same `127.0.0.1` HTTP server the Player uses. `chokidar` watches for changes, marks the deck dirty (Pack only — Source writes already persist), and triggers `webContents.reload()` on the preview view.
- The AI acts as a "file editor" — reading and writing files inside the rootDir, sandboxed so it can never escape the root.
- **Save model**: a Pack's edits are flushed back to its original `.deck` on `⌘S`, on `File → Save`, and automatically on close (best-effort, dirty only). A Source (user-owned directory) writes through directly — `⌘S` is a no-op.
- **Save As .deck…** (`⇧⌘S`) on either kind packs the current rootDir into a user-chosen `.deck` file — useful for branching off a copy or for promoting a Source directory into a Pack.

### 5.3 AI capabilities

- **Conversational generation**: _"Make a 10-slide deck about Transformers"_, _"Change slide 3 to a dark theme"_.
- **Tool use** — we reuse the tool factories from [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), wrapped with a sandbox that rejects any path outside the Deck Source (with a read-only allowlist for the bundled `skills/` directory so SKILL.md can be read by absolute path):
  - `read` — read any file in the Deck Source or `skills/`.
  - `write` — create or overwrite a file inside the Deck Source.
  - `edit` — string-replace edit inside a single file.
  - `ls` — list entries inside the Deck Source.
  - `grep` — search file contents for a regex (Node-native scanner; skips `node_modules` / `.git` / dotfiles / binaries by default).
  - `find` — locate files by glob (Node-native walker).
  - `add_asset` — Deck-specific: ingest the binary payloads the renderer stages (images / fonts / video). Takes `{ path, base64 }`; writes under `assets/` by default.
  - `delete_file` — Deck-specific: remove a single file. Refuses directories and the reserved files (`deck.json`, `index.html`).
  - `move_file` — Deck-specific: rename / relocate a file inside the Deck Source. Both endpoints stay sandboxed; cross-device renames fall back to copy + delete; refuses to clobber or relocate the reserved files.
  - `fetch_url` — Deck-specific: download an http(s) URL into the Deck Source (default: `assets/<name>`). 25 MB cap, http(s) only, routes through Electron's `net.fetch` so the user's session / proxy applies.
  - `validate_deck` — Deck-specific, read-only: parses `deck.json` and scans `index.html` for missing `src` / `href` references. Use after structural changes to confirm the deck still loads.

  `bash` and `list_skills` / `read_skill` are **intentionally absent**. No shell access in a desktop app (the prior `sandbox-exec`-based bash tool was removed in favor of the fine-grained read/write/edit/ls/grep/find surface). pi's defaults for `grep` / `find` shell out to `rg` / `fd` and silently download those binaries on first use — we override the operations with Node-native implementations so there are no surprise external binaries at runtime. Skills are surfaced via absolute paths in the system prompt and read with the standard `read` tool. See the comment block at the top of `src/main/ai/tools.ts` for the full rationale.

- **Context**: the system prompt includes a two-level listing of the Deck Source plus the `deck.json` summary, so the model can orient without a preliminary `ls` call.
- **Models**: provider-agnostic. Built-in choices (`src/main/ai/provider.ts`):
  - Anthropic — `claude-sonnet-4-6`, `claude-opus-4-7`, `claude-haiku-4-5`.
  - OpenAI — `gpt-5.1`, `gpt-5`, `gpt-5-mini`.
  - Google — `gemini-3-pro-preview`, `gemini-3-flash`, `gemini-2.5-pro`.

  Plus three "custom" provider slots (`custom-openai`, `custom-anthropic`, `custom-responses`) that let the user point at any OpenAI-compatible, Anthropic-compatible, or OpenAI-Responses endpoint by entering a base URL and model id.

- **API key resolution**: keys come **only** from the Settings UI (stored encrypted in `secrets.json` via `safeStorage`). Deck deliberately ignores pi-ai's built-in environment-variable fallback (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, …). Rationale: Deck is a desktop product whose users don't necessarily understand environment variables. Honoring an env-var-only key would put the composer in a state where Settings says "no key set" but Send still works — confusing for non-technical users, and inconsistent with the readiness gate (see `src/main/ai/readiness.ts`). Trade-off: developers running from a shell with exported keys still need to copy the key into Settings once.

> The AI writes HTML / CSS / JS directly — it does not manipulate a structured slide model. Freedom equals plain web development. The _"works out of the box"_ responsibility lives in **templates** (see 5.4), not in the spec or runtime.

### 5.4 Templates

A starter template is itself a minimal Deck; the AI edits on top. Each template contains a `deck.json` (with `name` only), an `index.html` (with arrow-key pagination and a `.slide` layout preset), and baseline CSS.

Today the app ships a single minimal template (`skills/create-deck/templates/`). A richer lineup — Minimal White / Tech Dark / Academic Paper / Keynote / Scrolling Longform — is _(planned)_.

### 5.5 Asset management

Drag an image / video / font into the chat composer, or paste with `⌘V` / `Ctrl+V`, to stage it as an attachment chip. When the AI receives the next message it invokes `add_asset` to write the payload into the Deck Source (default location: `assets/<filename>`) and references the file by relative path in its code.

### 5.6 Save / Export

- **Save** (`⌘S`) — for a Pack, rezips the live extraction back into the original `.deck` file. For a Source, no-op (writes already persist). Also runs automatically (best-effort, dirty only) on close. The Editor topbar shows a Save icon for Pack-kind decks with a small dot indicator when dirty.
- **Save As .deck…** (`⇧⌘S`) — packs the current rootDir into a user-chosen `.deck` path. Works on Pack and Source alike. Doesn't change which file the window is editing — the user can reopen the new `.deck` if they want to switch.
- **HTML directory export** — _(planned)_ emit the static site as-is.
- **PDF** — _(planned)_ Electron `printToPDF`.
- **MP4** — _(long-term)_ headless recording.

---

## 6. Menu

Menu items are declared once in `src/main/menu/` as a tree, and both the native Electron menu bar (macOS) and the self-drawn DOM menu in the renderer (Windows / Linux — the native menu bar is hidden to keep the chrome-less look) dispatch through the same action table. Enabled-state snapshots are rebuilt on every window focus / mode transition so items grey out when inapplicable (e.g. "Save" only enables when a Pack-kind Deck is loaded).

**Currently shipped:**

- **File** — New Deck… (`⌘N`) · New Window (`⌘⌥N`) · Open .deck… (`⌘O`) · Open Folder… (`⌘⇧O`) · Edit Deck (`⌘E`) · Play Deck (`⌘⌥P`) · Save (`⌘S`, Pack-only) · Save As .deck… (`⇧⌘S`) · Reveal in Finder / Explorer · Open Chats Folder · Close Window (`⌘W`) · Close Deck and Return to Launcher (`⌘⇧W`) · Quit.
- **Edit** — Undo · Redo · Cut · Copy · Paste · Select All. Routed to the focused chrome `WebContents` — the deck page runs untrusted content and is deliberately not a valid Edit target.
- **View** — Reload Preview (`⌘R`) · Force Reload Preview (`⌘⇧R`) · Actual Size · Zoom In · Zoom Out · Toggle Full Screen · Toggle Developer Tools. Reload only touches the deck preview; it never reloads the chrome view (would blow away in-flight AI state).

On macOS the standard app menu (About / Services / Hide / Quit) and an Electron-rendered `editMenu` role (for Dictation / Emoji & Symbols) are inserted by the OS conventions. Settings lives on the macOS app menu as `⌘,`; on Windows / Linux it appears under the File submenu with `Ctrl+,` and also opens via the gear icon in the topbar.

**Planned:**

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
