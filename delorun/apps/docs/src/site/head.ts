/**
 * The document head every page shares: title, description, canonical address and link-preview data.
 *
 * @module @delorun/docs/head
 */
import { SITE_URL } from './config.ts'
import { COPY } from './copy.ts'
import { htmlLangOf, type Locale } from './locale.ts'

/** The meta tags and links a route's `head` option returns. */
export interface PageHead {
  /** The title, description and link-preview meta tags. */
  meta: Array<Record<string, string>>
  /** The canonical link. */
  links: Array<{ rel: string, href: string }>
}

/**
 * The head of a page.
 * @param page - the page's title, its summary (`undefined` leaves out the description and the preview summary), its route on the published site such as `/guide/safety-and-updates/trust`, and its locale.
 * @returns the title, the description, the canonical address and the link-preview (Open Graph) tags.
 */
export function pageHead(page: { title: string, description: string | undefined, path: string, locale: Locale }): PageHead {
  const { title, description, path, locale } = page
  const url = `${SITE_URL}${path}`
  return {
    meta: [
      { title },
      ...description === undefined ? [] : [{ name: 'description', content: description }, { property: 'og:description', content: description }],
      { property: 'og:title', content: title },
      { property: 'og:type', content: 'website' },
      { property: 'og:url', content: url },
      { property: 'og:site_name', content: COPY[locale].siteTitle },
      { property: 'og:locale', content: htmlLangOf(locale) === 'zh-Hans' ? 'zh_CN' : 'en_GB' },
      { name: 'twitter:card', content: 'summary' },
    ],
    links: [{ rel: 'canonical', href: url }],
  }
}
