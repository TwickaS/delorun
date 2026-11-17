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
 * @returns the title, `og:title`, `twitter:title`, `og:url` and the canonical link.
 */
export function pageHead(title: string, path: string): PageHead {
  const url = `${SITE_URL}${path}`
  return {
    meta: [
      { title },
      { property: 'og:title', content: title },
      { name: 'twitter:title', content: title },
      { property: 'og:url', content: url },
    ],
    links: [{ rel: 'canonical', href: url }],
  }
}
