# Window Chrome Design

> How the Launcher and Player windows present themselves on each platform, why, and what's still unresolved.

This is an **implementation-side** design doc. For the author-facing contract (what Deck authors must know), see [`deck-spec.md` §6](./deck-spec.md).

---

## Goals

- **Player feels chrome-less.** The `.deck` takes the whole window; the surrounding OS chrome is as thin and unobtrusive as possible.
- **Launcher looks like a normal app.** It's the Deck App's own UI (deck list, actions), and should feel native.
- **Never trap the user.** The window must always be draggable, closable, and resizable via OS-standard affordances, without depending on Deck authors doing anything special.
- **Predictable for Deck authors.** A Deck that works on one platform shouldn't be surprise-broken on another by chrome differences.

## Constraint we keep bumping into

In Electron, **WebContents overlay the whole window**. On any platform where the OS titlebar is replaced with web content (any `titleBarStyle` other than `default`), the author page can accidentally steal pointer events from OS-native drag regions — even though those regions are supposed to be "above" the page. The fix is to either:

1. Keep a native titlebar band that physically sits above the web contents (Windows `titleBarOverlay`, Linux native titlebar), or
2. Inject a DOM element with `-webkit-app-region: drag` at the top of the page (macOS drag strip).

Everything below is the consequence of this constraint.

---

## macOS

| Window   | `titleBarStyle` | Traffic lights              | Overlay | Drag strip injection |
| -------- | --------------- | --------------------------- | ------- | -------------------- |
| Launcher | `hiddenInset`   | Visible, Electron default position | n/a     | No                   |
| Player   | `hiddenInset`   | Visible, Electron default position | n/a     | **Yes — 32px**       |

**Why `hiddenInset` for both.** It hides the native title text but keeps the traffic lights inset into the top-left. The surrounding titlebar band (≈28px) is the OS-native drag region. This matches what modern macOS apps (Xcode, Zed, VS Code) do.

**Why no `trafficLightPosition`.** Earlier we overrode this to `{ x: 12, y: 14 }`. We removed that — Electron's default is fine, and matches Safari/Finder better. See Electron source `shell/browser/native_window_mac.mm:303` for the built-in margin.

**Why the drag strip in the Player.** `hiddenInset`'s drag region is OS-native, but a Deck author's `position: fixed; top: 0` element (e.g. a Next.js nav bar) sits on top of it in the hit-test stack and steals drag events. The Launcher doesn't need this because its own renderer controls the top of the page. The Player hosts arbitrary author HTML, so we inject:

```html
<div style="
  position: fixed;
  top: 0; left: 0; right: 0;
  height: 32px;
  z-index: 2147483647;
  -webkit-app-region: drag;
  pointer-events: auto;
"></div>
```

Implementation: `src/main/player-titlebar.ts`. Injected via `executeJavaScript` on `did-finish-load` (idempotent via sentinel ID).

**Why 32px.** Matches the Windows `titleBarOverlay.height`, so the reserved author-page band is the same on both platforms. Big Sur's standard titlebar is 28px; 32px gives a small buffer and keeps a single number to remember.

**Trade-off.** The top 32px of the author page is **not clickable** — clicks in that band are swallowed and routed to the OS as drag. Author docs warn about this (`deck-spec.md` §6).

---

## Windows

| Window   | `titleBarStyle` | Caption buttons                    | Overlay                                                  | Drag strip injection |
| -------- | --------------- | ---------------------------------- | -------------------------------------------------------- | -------------------- |
| Launcher | `hidden`        | Visible, right side                | Theme-adaptive solid (`systemOverlay`), 32px             | No                   |
| Player   | `hidden`        | Visible, right side                | **Semi-transparent dark** (`PLAYER_OVERLAY`, #00000040), 32px | No                   |

**Why `titleBarOverlay`.** Windows 10+ can render just the min/max/close buttons ("caption buttons") and let the webview fill the rest. This gives a clean chrome-less feel similar to macOS `hiddenInset`. The caption buttons use the Window Controls Overlay web standard under the hood.

**Launcher: solid overlay, renderer-driven theme.** The Launcher renderer owns theme state ("follow system until user picks", persisted in `localStorage`). On every theme change the renderer IPCs `deck:set-chrome-theme` to the main process, which calls `applyChromeTheme` → `setTitleBarOverlay`. Initial overlay at window-create time is seeded from `nativeTheme.shouldUseDarkColors` as a best-effort default (there's a brief possible flash if the user's saved pick differs from the current system theme — accepted for simplicity). The main process does **not** subscribe to `nativeTheme.updated` directly: doing so would overwrite a user-persisted choice when the system theme flipped.

**Player: semi-transparent dark overlay.** The Player's `backgroundColor` is `#000000` (Decks paint against black until their CSS loads), so a purely transparent overlay would render the white caption button symbols invisible as soon as the Deck paints a light background. The chosen `#00000040` (~25% opacity black) anchors the white symbols with enough contrast on any deck background without imposing a visually heavy 32px bar. `symbolColor` is pinned to white because the tint is dark. The Deck App has no hook into the Deck's own theme today — a future `deck.json` `theme` field could drive overlay/symbol colors per-deck.

**Why no drag strip injection.** The `titleBarOverlay` band sits natively above web contents — author pages can't steal it. The 32px band is still reserved, but the reservation is handled by the overlay itself, not by injected DOM.

**Author impact.** The top 32px on Windows is visually covered by the overlay's caption buttons on the right (~140px). Authors are asked to avoid interactive content in the top 32px everywhere for cross-platform consistency, even though technically on Windows only the top-right button cluster is non-clickable.

**32px vs. native.** Windows 11 caption buttons are typically ~30px tall; we pick 32 to share a single "top 32px reserved" number with macOS. The cost is a small (~2px) discrepancy with native Explorer windows. We accept this for one-number authoring.

---

## Linux

| Window   | `titleBarStyle` | Caption buttons   | Overlay               | Drag strip injection |
| -------- | --------------- | ----------------- | --------------------- | -------------------- |
| Launcher | `hidden`        | Depends on WM     | Same config as Windows | No                   |
| Player   | `hidden`        | Depends on WM     | Same config as Windows | No                   |

**Current state:** shares the Windows code path but unverified, likely rough.

Electron implements `titleBarOverlay` for **both Windows and Linux** via the shared `NativeWindowViews` C++ class (see `shell/browser/native_window_views.cc`). In practice, whether overlay-style caption buttons actually render on Linux depends on the window manager / theme engine — there's no analogue to Windows DWM that guarantees consistent chrome across desktop environments. On GNOME/Mutter it can work; on tiling WMs or KDE it may not, and hardware-accelerated Wayland compositors introduce more variation.

The code in `windows.ts` treats Linux as "Windows minus thorough testing": same `titleBarStyle: 'hidden'`, same overlay config passed to `titleBarOverlay`. `playerChrome.injectDragStrip` is `false` for Linux (the `LINUX` strategy copies the Windows values), so if the overlay fails to render properly on a given WM, the window won't be draggable.

**Known gaps:**

- We don't test on any Linux distro/WM as part of the release process.
- The dark overlay tint designed for Windows Player may not match the user's GTK/Qt theme expectations.
- No fallback path if overlay fails to render.

**Possible fixes (not yet decided):**

1. **Use the native titlebar on Linux.** Change `LINUX.launcher.titleBarStyle` / `LINUX.player.titleBarStyle` to let the WM draw a normal frame. Simplest, loses the chrome-less look.
2. **Inject a drag strip on Linux too.** Flip `LINUX.player.injectDragStrip` to `true`. Window becomes draggable by the top 32px, but there are still no caption buttons — user has to close via keyboard shortcut or WM menu.
3. **Ship a minimal custom titlebar.** Render close/min/max buttons inside the page. Most involved; needs theme awareness.

Track this as a known gap; revisit when Linux is an actively supported target. The "Linux inherits Windows" decision is written explicitly in `src/main/chrome-strategy.ts` as a field-for-field copy of the `WIN` strategy (not a reference), so future edits touch Linux as a separate, visible step.

---

## Cross-cutting: the "top 32px" contract

Across platforms, the **top 32px of the Player's author-page coordinate space is effectively unusable** for clickable content. It is either:

- **macOS** — a transparent drag strip injected by the Deck App (swallows clicks),
- **Windows** — the `titleBarOverlay` band (caption buttons on the right, drag in the middle and on the sides), or
- **Linux** — the same `titleBarOverlay` config as Windows where the WM renders it; otherwise (unsupported WMs) the band is there in config but may not be draggable at runtime.

Authors see a single rule: **don't put interactive or visually important content in the top 32px**. See `deck-spec.md` §6 for the author-facing phrasing.

The 32px number is the contract between the Deck App and Deck authors. Changing it later would be a breaking change for any Deck that built a header against that boundary.

---

## Related source

- `src/main/chrome-strategy.ts` — per-platform chrome config (single source of truth for the "what to set" decisions).
- `src/main/windows.ts` — `showLauncherWindow`, `openDeckInNewWindow`, `applyChromeTheme`. Reads from `chrome-strategy.ts`.
- `src/main/player-titlebar.ts` — drag strip injection; caller gates on `playerChrome.injectDragStrip`.
- `src/renderer/launcher-components.css`, `launcher-layout.css` — Launcher-side CSS that respects the platform chrome.
