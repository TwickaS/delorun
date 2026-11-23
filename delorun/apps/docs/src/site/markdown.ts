/**
 * Each page as Markdown, and the `llms.txt` index of each locale's pages. A page's Markdown is its source with the
 * links resolved by {@link resolveLink}, the same resolution the HTML pages get. The build reads these through the
 * Markdown routes; they read files, so only the build's server code imports this module.
 *
 * @module @delorun/docs/markdown
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { COPY } from './copy.ts'
import { repositoryRoot, resolveLink } from './doc-links.ts'
import { prefixOf, type Locale } from './locale.ts'
import { isSection, markdownSlugOf, pageSlugsOf, SECTIONS, type Section } from './routes.ts'
import { sources } from './source.ts'

/**
 * The Markdown of one page: its source without frontmatter, with each link resolved as the page's HTML links are, so a
 * link to another page names that page's route and a link to an unpublished Delorun file names its URL on GitHub.
 * @param section - the section.
 * @param slug - the route slug, which {@link markdownSlugOf} produces.
 * @param locale - the locale.
 * @returns the Markdown text, or undefined when no page has those slugs.
 * @throws Error via {@link resolveLink} when a link names no file, so the build fails.
 */
export function pageMarkdown(section: Section, slug: readonly string[], locale: Locale): string | undefined {
  const page = sources[section].getPage(pageSlugsOf(slug), locale)
  if (page === undefined) return undefined
  const root = repositoryRoot()
  const file = join(root, 'delorun/docs', section, page.path)
  const source = readFileSync(file, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '')
  return source.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_link, text: string, href: string) => {
    return `[${text}](${resolveLink(file, href, root).href})`
  })
}

/**
 * The title of a page's Markdown: its first level-one heading.
 * @param markdown - the page's Markdown.
 * @returns the heading text, or an empty string when the page has none.
 */
export function titleOf(markdown: string): string {
  return /^# (.+)$/m.exec(markdown)?.[1]?.trim() ?? ''
}

/**
 * The `llms.txt` index of a locale: each section's pages as links to their Markdown.
 * @param locale - the locale.
 * @returns the index text.
 */
export function llmsIndex(locale: Locale): string {
  const copy = COPY[locale]
  const lines = [`# ${copy.siteTitle}`, '', `> ${copy.homeIntro}`]
  for (const section of SECTIONS) {
    lines.push('', `## ${copy.sectionNames[section]}`, '')
    for (const page of sources[section].getPages(locale)) {
      const slug = markdownSlugOf(page)
      const url = `${prefixOf(locale)}/llms.mdx/${[section, ...slug].join('/')}`
      const markdown = pageMarkdown(section, slug, locale) ?? ''
      lines.push(`- [${titleOf(markdown) || page.slugs.join('/') || section}](${url})`)
    }
  }
  return `${lines.join('\n')}\n`
}

/**
 * The response of a Markdown route.
 * @param section - the route's section segment, as requested.
 * @param slug - the route's slug.
 * @param locale - the locale.
 * @returns the page's Markdown, or a 404 response when no page has that route.
 */
export function markdownResponse(section: string, slug: readonly string[], locale: Locale): Response {
  const markdown = isSection(section) ? pageMarkdown(section, slug, locale) : undefined
  if (markdown === undefined) return new Response('Not found\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })
  return new Response(markdown, { headers: { 'content-type': 'text/markdown; charset=utf-8' } })
}
