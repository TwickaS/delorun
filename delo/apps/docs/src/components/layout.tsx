/**
 * The site's header in each locale: the theme's header with the site title, the locale's home page and the product
 * site's link.
 *
 * @module @delo/docs/layout
 */
import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'
import { headerOptions } from '@/theme/header.ts'
import { PRODUCT_URL } from '@/site/config.ts'
import { COPY } from '@/site/copy.ts'
import { prefixOf, type Locale } from '@/site/locale.ts'

/**
 * The shared layout options of a locale.
 * @param locale - the locale, which selects the labels and the home page.
 * @returns the header's title and links.
 */
export function baseOptions(locale: Locale): BaseLayoutProps {
  const copy = COPY[locale]
  return headerOptions({
    title: copy.siteTitle,
    homeUrl: prefixOf(locale) || '/',
    links: [{ text: copy.productLabel, url: PRODUCT_URL, external: true }],
  })
}
