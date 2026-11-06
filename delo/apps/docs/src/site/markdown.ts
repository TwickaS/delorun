/**
 * Each page as Markdown, and the `llms.txt` index of each locale's pages. A page's Markdown is its source with the
 * links resolved by {@link resolveLink}, the same resolution the HTML pages get.
 *
 * @module @delo/docs/markdown
 */
import { readFileSync } from 'node:fs'
import { isSection, repositoryRoot, resolveLink, type Section } from './doc-links.ts'
import { COPY } from './copy.ts'
import { prefixOf, type Locale } from './locale.ts'
import { sources } from './source.ts'

/** The sections, in the order the index lists them. */
const SECTIONS: readonly Section[] = ['guide', 'reference']

/** A page's route parameters for its Markdown route. */
export interface MarkdownParams {
  readonly section: Section
  readonly slug: string[]
}

/**
 * The Markdown route's slug of a page. A directory's index page (`README`) takes a trailing `index` segment, which keeps
 * a section index from being a file beside its children's directory in the static export.
 * @param page - the page, with its file path and slugs.
 * @returns the route slug, such as `['trust']`, `['index']` or `['divergence', 'index']`.
 */
export function markdownSlugOf(page: { readonly path: string, readonly slugs: readonly string[] }): string[] {
  return /(?:^|\/)README(?:\.zh)?\.md$/.test(page.path) ? [...page.slugs, 'index'] : [...page.slugs]
}

/**
 * The page slugs of a Markdown route's slug: the inverse of {@link markdownSlugOf}.
 * @param slug - the route slug.
 * @returns the page's slugs; an `index` segment names its directory's index page.
 */
export function pageSlugsOf(slug: readonly string[]): string[] {
  return slug.at(-1) === 'index' ? slug.slice(0, -1) : [...slug]
}

/**
 * Every page of a locale, as route parameters for its Markdown route.
 * @param locale - the locale.
 * @returns the parameters.
 */
export function markdownParams(locale: Locale): MarkdownParams[] {
  return SECTIONS.flatMap(section => sources[section].getPages(locale).map(page => ({ section, slug: markdownSlugOf(page) })))
}

/**
 * The Markdown of one page: its source without frontmatter, with each link resolved as the page's HTML links are, so a
 * link to another page names that page's route and a link to an unpublished Delo file reads as its path.
 * @param section - the section.
 * @param slug - the route slug, which {@link markdownSlugOf} produces.
 * @param locale - the locale.
 * @returns the Markdown text, or undefined when no page has those slugs.
 * @throws Error via {@link resolveLink} when a link names no file, so the build fails.
 */
export async function pageMarkdown(section: Section, slug: readonly string[], locale: Locale): Promise<string | undefined> {
  const page = sources[section].getPage(pageSlugsOf(slug), locale)
  if (page?.absolutePath === undefined) return undefined
  const root = repositoryRoot()
  const source = readFileSync(page.absolutePath, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '')
  return source.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_link, text: string, href: string) => {
    const resolved = resolveLink(page.absolutePath ?? '', href, root)
    return resolved.kind === 'href' ? `[${text}](${resolved.href})` : `\`${resolved.path}\``
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
export async function llmsIndex(locale: Locale): Promise<string> {
  const copy = COPY[locale]
  const lines = [`# ${copy.siteTitle}`, '', `> ${copy.homeIntro}`]
  for (const section of SECTIONS) {
    lines.push('', `## ${copy.sectionNames[section]}`, '')
    for (const page of sources[section].getPages(locale)) {
      const url = `${prefixOf(locale)}/llms.mdx/${[section, ...markdownSlugOf(page)].join('/')}`
      const markdown = (await pageMarkdown(section, page.slugs, locale)) ?? ''
      lines.push(`- [${titleOf(markdown) || page.slugs.join('/') || section}](${url})`)
    }
  }
  return `${lines.join('\n')}\n`
}
