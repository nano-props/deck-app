// Shared "X minutes ago" formatter. Floor-based so 1.9 days reads as
// "1 day ago", not "2 days ago".

const RTF = typeof Intl !== 'undefined' && Intl.RelativeTimeFormat
  ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  : null

export function formatRelative(ms) {
  if (!ms) return ''
  const diffSec = Math.round((ms - Date.now()) / 1000)
  const abs = Math.abs(diffSec)
  const sign = diffSec < 0 ? -1 : 1
  if (!RTF) return new Date(ms).toLocaleString()
  const f = (s, unit) => RTF.format(sign * Math.floor(abs / s), unit)
  if (abs < 60) return f(1, 'second')
  if (abs < 3600) return f(60, 'minute')
  if (abs < 86400) return f(3600, 'hour')
  if (abs < 86400 * 30) return f(86400, 'day')
  if (abs < 86400 * 365) return f(86400 * 30, 'month')
  return f(86400 * 365, 'year')
}
