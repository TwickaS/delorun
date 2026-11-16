/**
 * The sitemap `sitemap.xml` that the build writes beside the pages.
 *
 * @module @delorun/website/sitemap
 */
import { SITE_URL } from './config.ts'

/**
 * The pages a visitor can reach.
 * @param paths - the pages that always exist, such as `/` and `/privacy`.
 * @param articles - how many articles are published; the blog index is a page only when at least one is.
 * @returns the paths in listing order.
 */
export function sitemapPaths(paths: readonly string[], articles: number): string[] {
  return [...paths, ...articles === 0 ? [] : ['/blog']]
}

/**
 * The sitemap document.
 * @param paths - the site paths to list, each starting with `/`.
 * @returns the XML text, ending with one newline.
 */
export function sitemapXml(paths: readonly string[]): string {
  const urls = paths.map(path => `  <url><loc>${SITE_URL}${path}</loc></url>`)
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`
}
