/**
 * The site's header in each locale: the shared header's title, the locale's home page, the link to the product site and
 * the shared theme control.
 *
 * @module @delorun/docs/layout
 */
import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'
import { headerOptions } from '@/theme/header.ts'
import { COPY } from '@/site/copy.ts'
import { prefixOf, type Locale } from '@/site/locale.ts'
import { productLink, THEME_COPY } from '@/site/shell-copy.ts'

/**
 * The shared layout options of a locale.
 * @param locale - the locale, which selects the labels and the home page.
 * @returns the header's title, links and theme control.
 */
export function baseOptions(locale: Locale): BaseLayoutProps {
  return headerOptions({
    title: COPY[locale].siteTitle,
    homeUrl: prefixOf(locale) || '/',
    links: [productLink(locale)],
    theme: THEME_COPY[locale],
  })
}
