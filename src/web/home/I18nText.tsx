// Render a localized string that may contain trusted HTML (the dict
// values are app-controlled, so dangerouslySetInnerHTML is safe).
//
// Wraps the read-from-store + dangerouslySetInnerHTML pattern so each
// section component stays declarative. Defaults to <span>, but any tag
// can be passed as the `as` prop — important because some keys land
// inside `<h1>`, `<h3>`, `<p>` etc, where wrapping in <span> would
// break inherited styles or block-level layout.

import { type ElementType } from 'react'
import { useI18n, asHtml, type DictKey } from '#/web/lib/i18n.ts'

interface Props {
  k: DictKey
  as?: ElementType
  className?: string
}

export function I18nText({ k, as: Tag = 'span', className }: Props) {
  const t = useI18n((s) => s.t)
  return <Tag className={className} dangerouslySetInnerHTML={asHtml(t(k))} />
}
