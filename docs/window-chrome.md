# Window Chrome Design

> How the Deck App window presents itself on each platform, why, and what's still unresolved.

This is an **implementation-side** design doc. For the author-facing contract (what Deck authors must know), see [`deck-spec.md` §6](./deck-spec.md).

---

## Goals

- **Player feels chrome-less.** The `.deck` takes the whole body below a slim persistent topbar; the surrounding OS chrome is as thin and unobtrusive as possible.
- **Launcher looks like a normal app.** It's the Deck App's own UI (deck list, actions), and should feel native.
- **Never trap the user.** The window must always be draggable, closable, and resizable via OS-standard affordances, without depending on Deck authors doing anything special.
- **Predictable for Deck authors.** A Deck that works on one platform shouldn't be surprise-broken on another by chrome differences.

## Single window, single chrome

The Deck App is a **single-window** application: one `BaseWindow` hosts a `chromeView` (always) and, when a Deck is loaded, a `deckView` as a sibling `WebContentsView` positioned below the topbar (Player mode) or inside the preview pane of a split layout (Editor mode). Because the native view is a sibling — not a child of the chrome DOM — there's no difference between Launcher / Player / Editor at the chrome level; all three share one **`appChrome`** strategy per platform (see `src/main/chrome-strategy.ts`).

The chromeView draws a persistent **32px topbar** that stays mounted in every mode. That single number is repeated deliberately:

- `TOPBAR_PX = 32` in `src/main/window-layout.ts` (the canonical constant).
- `grid-template-rows: ${TOPBAR_PX}px 1fr` in `src/renderer/App.tsx` (root grid, imported from `window-layout.ts`).
- `OVERLAY_HEIGHT = TOPBAR_PX` in `src/main/chrome-strategy.ts` (Windows/Linux `titleBarOverlay` config).
- The macOS traffic-light centering math in the window constructor (`src/main/app-window/index.ts`) reads `TOPBAR_PX` directly.

Because the topbar is always there, the `deckView` never sits under the OS traffic lights or caption buttons, and no special handling is needed to keep those regions draggable. See [macOS](#macos) for what this replaces.

## Constraint we keep bumping into

In Electron, **WebContents overlay the whole window**. On any platform where the OS titlebar is replaced with web content (any `titleBarStyle` other than `default`), an author page can accidentally steal pointer events from OS-native drag regions — even though those regions are supposed to be "above" the page. Two ways out:

1. Keep a native titlebar band that physically sits above the web contents (Windows / Linux `titleBarOverlay`).
2. Keep the native view out of the top band entirely — which is what the persistent topbar accomplishes on all three platforms.

Everything below is the consequence of this constraint.

---

## macOS

| `titleBarStyle` | Traffic lights                                | Overlay | Drag strip injection |
| --------------- | --------------------------------------------- | ------- | -------------------- |
| `hiddenInset`   | Visible, centered in the 32px topbar via math | n/a     | **No (deprecated)**  |

**Why `hiddenInset`.** It hides the native title text but keeps the traffic lights inset into the top-left. This matches what modern macOS apps (Xcode, Zed, VS Code) do.

**Traffic-light centering.** Big Sur's standard titlebar is 28px; our topbar is 32px. The window constructor sets `trafficLightPosition` to center the buttons vertically in the 32px band. The magic number lives in one place (`TOPBAR_PX`) so changing the topbar height doesn't leave traffic lights dangling.

**No drag strip.** Earlier versions of the Player mode injected a transparent `-webkit-app-region: drag` DOM element at the top of the deck page to steal drag events back from author `position: fixed; top: 0` elements. With the persistent chrome topbar, the deckView starts at `y = 32` and never overlaps the OS-native drag region around the traffic lights, so the injection isn't needed. `src/main/player-titlebar.ts` and the `playerInjectDragStrip` flag in `chrome-strategy.ts` are kept as dormant plumbing for a future full-bleed "Present" mode where the topbar is hidden; in the normal Player mode nothing calls them.

---

## Windows

| `titleBarStyle` | Caption buttons     | Overlay                                        | Drag strip injection |
| --------------- | ------------------- | ---------------------------------------------- | -------------------- |
| `hidden`        | Visible, right side | Theme-adaptive solid (`overlayForTheme`), 32px | No                   |

**Why `titleBarOverlay`.** Windows 10+ can render just the min/max/close buttons ("caption buttons") and let the webview fill the rest. This gives a clean chrome-less feel similar to macOS `hiddenInset`. The caption buttons use the Window Controls Overlay web standard under the hood.

**Theme-adaptive overlay, renderer-driven.** The renderer owns theme state ("follow system until user picks", persisted in the renderer's settings state). On every theme change the renderer IPCs the main process, which calls `setTitleBarOverlay` with `overlayForTheme(dark)` — white/black for light, black/white for dark. Initial overlay at window-create time is seeded from `nativeTheme.shouldUseDarkColors` as a best-effort default (there's a brief possible flash if the user's saved pick differs from the current system theme — accepted for simplicity). The main process does **not** subscribe to `nativeTheme.updated` directly: doing so would overwrite a user-persisted choice when the system theme flipped.

**One overlay, not two.** Earlier designs used a separate translucent dark overlay in Player mode (because the deckView covered the caption area, so the buttons had to stay readable against arbitrary deck backgrounds). With the persistent topbar, the caption buttons always sit over the chromeView background, never over deck content — so we use a single solid theme-matched overlay across all modes.

**Native menu bar hidden.** On Windows / Linux `setMenuBarVisibility(false)` is called so the legacy menu bar never flashes. The native `Menu` is still installed via `Menu.setApplicationMenu` so global accelerators (`⌘N`, `⌘O`, `⌘E`, `F11`, etc.) stay bound, and a self-drawn DOM menu in the topbar renders the same tree (see `src/renderer/components/AppMenu.tsx`).

**32px vs. native.** Windows 11 caption buttons are typically ~30px tall; we pick 32 to share a single "top 32px reserved" number with macOS. The cost is a small (~2px) discrepancy with native Explorer windows. We accept this for one-number authoring and a shared constant with the topbar height.

---

## Linux

| `titleBarStyle` | Caption buttons | Overlay                | Drag strip injection |
| --------------- | --------------- | ---------------------- | -------------------- |
| `hidden`        | Depends on WM   | Same config as Windows | No                   |

**Current state:** shares the Windows code path but unverified, likely rough.

Electron implements `titleBarOverlay` for **both Windows and Linux** via the shared `NativeWindowViews` C++ class (see `shell/browser/native_window_views.cc`). In practice, whether overlay-style caption buttons actually render on Linux depends on the window manager / theme engine — there's no analogue to Windows DWM that guarantees consistent chrome across desktop environments. On GNOME/Mutter it can work; on tiling WMs or KDE it may not, and hardware-accelerated Wayland compositors introduce more variation.

The `LINUX` strategy in `chrome-strategy.ts` is a **field-for-field copy** of `WIN` (not a reference — the explicit copy ensures future edits touch Linux as a separate, visible step). Since we don't inject a drag strip, if the overlay fails to render properly on a given WM the window won't be draggable.

**Known gaps:**

- We don't test on any Linux distro/WM as part of the release process.
- The theme-matched overlay tint designed for Windows may not match the user's GTK/Qt theme expectations.
- No fallback path if overlay fails to render.

**Possible fixes (not yet decided):**

1. **Use the native titlebar on Linux.** Change `LINUX.titleBarStyle` to `default` and let the WM draw a normal frame. Simplest, loses the chrome-less look.
2. **Inject a drag strip on Linux.** Flip `LINUX.playerInjectDragStrip` to `true` _and_ add a call site (currently none). Requires reviving `player-titlebar.ts` out of dormancy.
3. **Ship a minimal custom titlebar.** Render close/min/max buttons inside the topbar. Most involved; needs theme awareness.

Track this as a known gap; revisit when Linux is an actively supported target.

---

## Cross-cutting: deck viewport vs window coordinates

The persistent chrome topbar sits in the top 32px of the **window**. The deckView is sized and positioned by the renderer (see `app:set-preview-bounds`) to start at `y = 32`, so the deck page's `(0, 0)` corresponds to the pixel directly below the topbar, not the top of the OS window. Traffic lights / caption buttons live in the chrome's coordinate space, never on top of the deck.

**Practical implication:** the deck has the full viewport to itself — there is no reserved dead-zone inside the deck page. Earlier versions of this app injected a transparent drag strip into the top of the author page on macOS (see `src/main/player-titlebar.ts`, dormant); with the persistent topbar that injection is no longer needed and is no longer wired up.

Author-facing guidance lives in `skills/create-deck/reference/spec-lite.md §6`.

---

## Related source

- `src/main/chrome-strategy.ts` — per-platform chrome config (single source of truth for the "what to set" decisions). Exports one `appChrome` per platform, shared across Launcher / Player / Editor.
- `src/main/window-layout.ts` — `TOPBAR_PX`, the only main-side layout constant. Splitter / pane geometry is renderer-owned (CSS + the inline divider in `Editor.tsx`); main mirrors what the renderer measures via `app:set-preview-bounds`.
- `src/main/app-window/index.ts` — `AppWindow` class: creates the `BaseWindow` + `chromeView` + on-demand `deckView`, applies chrome from `chrome-strategy.ts`, lays views out per mode.
- `src/main/window-registry.ts` — registry of open windows keyed by canonical deck source path, so the same Deck is never opened twice.
- `src/main/player-titlebar.ts` — dormant macOS drag-strip injection. Kept for potential re-use in a future full-bleed Present mode.
- `src/renderer/styles.css` — chromeView base layout (`@theme` design tokens, `html/body/#root` reset, `.topbar` padding rules including the Win/Linux right-padding reservation for the OS caption buttons). The topbar grid row itself is inlined in `App.tsx` and reads `TOPBAR_PX` from `window-layout.ts`.
