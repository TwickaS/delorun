/**
 * The sitemap `sitemap.xml` that the build writes beside the pages.
 *
 * @module @delorun/docs/sitemap
 */
import { SITE_URL } from './config.ts'

/**
 * The prerendered paths that are pages a visitor reads, without the 404 page, the `llms.txt` indexes, the Markdown
 * routes and the search index.
 * @param paths - every prerendered path, from {@link import('./pages.ts').prerenderPaths}.
 * @returns the page paths in the given order.
 */
export function pagePaths(paths: readonly string[]): string[] {
  return paths.filter(path => path !== '/404' && !/\/llms\.(?:txt|mdx\/)|\.json$/.test(path))
}

/**
 * The sitemap document.
 * @param paths - the page paths, each starting with `/`.
 * @returns the XML text, ending with one newline.
 */
export function sitemapXml(paths: readonly string[]): string {
  const urls = paths.map(path => `  <url><loc>${SITE_URL}${path}</loc></url>`)
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`
}
