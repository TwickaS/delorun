/**
 * The document head every page shares: title, description, canonical address and link-preview data.
 *
 * @module @delorun/docs/head
 */
import { SITE_URL } from './config.ts'
import { htmlLangOf, type Locale } from './locale.ts'

/** The product name that link previews show as the site. */
const SITE_NAME = 'Delorun documentation'

/**
 * The head of a page.
 * @param page.title - the page's title.
 * @param page.description - the page's summary; none leaves out the description and the preview summary.
 * @param page.path - the page's route on the published site, such as `/guide/trust`.
 * @param page.locale - the page's locale.
 * @returns the title, the description, the canonical address and the link-preview (Open Graph) tags.
 */
export function pageHead({ title, description, path, locale }: { title: string, description: string | undefined, path: string, locale: Locale }) {
  const url = `${SITE_URL}${path}`
  return {
    meta: [
      { title },
      ...description === undefined ? [] : [{ name: 'description', content: description }, { property: 'og:description', content: description }],
      { property: 'og:title', content: title },
      { property: 'og:type', content: 'website' },
      { property: 'og:url', content: url },
      { property: 'og:site_name', content: SITE_NAME },
      { property: 'og:locale', content: htmlLangOf(locale) === 'zh-Hans' ? 'zh_CN' : 'en_GB' },
      { name: 'twitter:card', content: 'summary' },
    ],
    links: [{ rel: 'canonical', href: url }],
  }
}
