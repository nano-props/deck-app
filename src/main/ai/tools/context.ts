/**
 * Context object threaded into `createDeckTools` and every individual
 * handler factory. Decouples the AI session layer (which constructs the
 * context) from the tool layer (which consumes it) — keeping this in a
 * separate module lets handler files import the type without dragging
 * in any runtime code, which keeps the dependency graph a clean DAG
 * (handlers → context, ops → context, never the reverse).
 */
export interface DeckToolsContext {
  /** Absolute path to the Deck Source root. All tool ops are confined here. */
  rootDir: string
  /**
   * Optional notifier invoked after a tool mutates the Deck Source
   * (write / edit / add_asset / delete_file / move_file / fetch_url).
   * Used by the Edit sub-view to auto-reload the preview once the agent
   * has finished editing. Path is relative to rootDir, POSIX-style.
   * `move_file` fires it twice — once for the source, once for the
   * destination — so a watcher / preview reload picks up both sides.
   */
  onFileChange?: (relPath: string) => void
  /**
   * Optional preview-snapshot capture, supplied by the session layer.
   * When present, `screenshot_preview` is exposed to the agent so it
   * can see the rendered deck. Absent in tests / unit-construction
   * paths that don't own a live deckView — the tool is omitted in that
   * case, so the model never sees a tool that would always fail.
   */
  capturePreview?: () => Promise<{ dataUrl: string } | null>
}
