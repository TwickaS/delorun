/**
 * The head tags each indexed page carries beside the shared ones in the root route: its title, its canonical address,
 * and the link-preview title and address that name the page itself rather than the site.
 *
 * @module @delorun/website/head
 */
import { SITE_URL } from './config.ts'

/** A page's own head tags, in the form a route's `head` returns; the router's types take mutable arrays. */
export interface PageHead {
  readonly meta: ({ title: string } | { property: string, content: string } | { name: string, content: string })[]
  readonly links: { rel: 'canonical', href: string }[]
}

/**
 * The head tags of one indexed page.
 * @param title - the page's title, as the browser tab and the link preview show it.
 * @param path - the page's path on the site, starting with `/`.
 * @param description - the page's own description; the shared home description stays when it is absent.
 * @returns the title, `og:title`, `twitter:title`, `og:url`, the description tags when given, and the canonical link.
 */
export function pageHead(title: string, path: string, description?: string): PageHead {
  const url = `${SITE_URL}${path}`
  return {
    meta: [
      { title },
      { property: 'og:title', content: title },
      { name: 'twitter:title', content: title },
      { property: 'og:url', content: url },
      ...(description === undefined
        ? []
        : [
            { name: 'description', content: description },
            { property: 'og:description', content: description },
            { name: 'twitter:description', content: description },
          ]),
    ],
    links: [{ rel: 'canonical', href: url }],
  }
}
