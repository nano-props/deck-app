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
  const resolved = path.resolve(p)
  return CASE_INSENSITIVE ? resolved.toLowerCase() : resolved
}

/** True iff `a` and `b` resolve to the same FS identity. */
export function pathsEqual(a: string, b: string): boolean {
  return canonicalPath(a) === canonicalPath(b)
}
