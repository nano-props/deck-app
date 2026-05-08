export function humanBytes(n: number): string {
  if (!Number.isFinite(n)) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

export function formatTokens(n: number): string {
  if (n >= 1000) return `${Math.round(n / 100) / 10}k`
  return `${n}`
}

export function formatNumber(n: number): string {
  return n.toLocaleString()
}

/**
 * Heuristic: does this pasted text look like code? Conservative — false
 * positives turn into a one-click "wrap in fence" affordance the user
 * can ignore, but we don't want it bouncing on every multi-line prose
 * paste either. Signals:
 *   1. Multi-line.
 *   2. Has at least one bracket pair, semicolon, or `=>` arrow.
 *   3. Few (or no) sentence terminators relative to length — prose
 *      tends to have one full-stop per ~80 chars.
 */
export function looksLikeCode(s: string): boolean {
  if (!s.includes('\n')) return false
  if (s.length < 20) return false
  const hasCodeShape = /[{}[\]();]|=>/.test(s)
  if (!hasCodeShape) return false
  const sentenceEnders = (s.match(/[.。?？!！]\s/g) ?? []).length
  return sentenceEnders < s.length / 120
}
