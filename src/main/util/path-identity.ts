import path from 'node:path'

/**
 * Identity-compare paths the way the host filesystem would.
 *
 * macOS HFS+/APFS and Windows NTFS treat paths case-insensitively by
 * default, so `/Users/Foo/x.deck` and `/users/foo/x.deck` refer to the
 * same file there. Linux is case-sensitive — keep the literal path.
 *
 * Centralized here so the deck identity rule lives in one place: deck
 * lookup (window-registry), recents dedup (recents), and chat history
 * keying (chats) all agree.
 */
const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32'

/** Canonical form for hashing or map-keying a path. */
export function canonicalPath(p: string): string {
  // NFC-normalize first so paths copy-pasted from different sources
  // (browser, terminal, OS file picker) compare equal even when one
  // arrives in NFD and the other in NFC — common on macOS, where the
  // FS itself stores filenames in NFD but user input is typically NFC.
  const resolved = path.resolve(p).normalize('NFC')
  return CASE_INSENSITIVE ? resolved.toLowerCase() : resolved
}

/** True iff `a` and `b` resolve to the same FS identity. */
export function pathsEqual(a: string, b: string): boolean {
  return canonicalPath(a) === canonicalPath(b)
}
