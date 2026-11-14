/**
 * The site paths the build prerenders, read from the page files the way the page sources read them: each English page
 * `<name>.md` is served in English and in Chinese, from `<name>.zh.md` when the pair exists and from the English text
 * otherwise, and a Chinese page without an English page is served in Chinese only.
 *
 * @module @delorun/docs/pages
 */
import { readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { SEARCH_INDEX_PATH } from './config.ts'
import { changelogRoute, markdownSlugOf, routeOf, SECTIONS, slugsOf } from './routes.ts'
import { prefixOf, type Locale } from './locale.ts'

/**
 * Every Markdown file under a directory, as paths relative to it with `/` separators.
 * @param dir - the directory.
 * @returns the relative paths.
 */
function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter(path => path.endsWith('.md'))
    .map(path => relative(dir, join(dir, path)).split(sep).join('/'))
}

/**
 * The site paths of every page, its Markdown and the site's indexes, for the prerender list.
 * @param root - the repository root.
 * @param changelog - whether a changelog record is published, which adds the changelog page in both locales.
 * @returns the paths, with the home pages, the 404 page, the `llms.txt` indexes and the search index.
 */
export function prerenderPaths(root: string, changelog: boolean): string[] {
  const paths = ['/', '/zh', '/404', '/llms.txt', '/zh/llms.txt', SEARCH_INDEX_PATH]
  if (changelog) paths.push(changelogRoute(false), changelogRoute(true))
  for (const section of SECTIONS) {
    const files = markdownFiles(join(root, 'delorun/docs', section))
    const english = new Set(files.filter(path => !path.endsWith('.zh.md')))
    const chineseOnly = files.filter(path => path.endsWith('.zh.md') && !english.has(path.replace(/\.zh\.md$/, '.md')))
    const pages: { path: string, locales: Locale[] }[] = [
      ...[...english].map(path => ({ path, locales: ['en', 'zh'] satisfies Locale[] })),
      ...chineseOnly.map(path => ({ path, locales: ['zh'] satisfies Locale[] })),
    ]
    for (const { path, locales } of pages) {
      const slugs = slugsOf(path)
      for (const locale of locales) {
        paths.push(routeOf(section, slugs, locale === 'zh'))
        paths.push(`${prefixOf(locale)}/llms.mdx/${[section, ...markdownSlugOf({ path, slugs })].join('/')}`)
      }
    }
  }
  return paths
}
