/**
 * The site's routes for Delorun's pages: a page file's slugs, its HTML route and its Markdown route. These functions read
 * no file, so the browser and the build both use them.
 *
 * @module @delorun/docs/routes
 */

/** The published section names, which are also the first route segment. */
export type Section = 'guide' | 'reference'

/** The sections, in the order the site lists them. */
export const SECTIONS: readonly Section[] = ['guide', 'reference']

/**
 * Whether a string names a published section.
 * @param value - the candidate name.
 * @returns true for `guide` and `reference`.
 */
export function isSection(value: string): value is Section {
  return value === 'guide' || value === 'reference'
}

/**
 * The route slugs of a page, relative to its section.
 * @param pagePath - the page's path relative to its section directory, such as `trust.zh.md` or `divergence/README.md`.
 * @returns the slugs; an index page (`README`) yields the slugs of its directory.
 */
export function slugsOf(pagePath: string): string[] {
  const base = pagePath.replace(/(?:\.zh)?\.md$/, '')
  if (base === 'README') return []
  return base.replace(/\/README$/, '').split('/').filter(part => part !== '')
}

/**
 * The Markdown route's slug of a page. A directory's index page (`README`) takes a trailing `index` segment, which keeps
 * a section index from being a file beside its children's directory in the static output.
 * @param page - the page, with its file path relative to its section directory and its slugs.
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
 * The site route of a published page.
 * @param section - the section, `guide` or `reference`.
 * @param slugs - the page's slugs within its section.
 * @param chinese - whether the page is the Chinese half.
 * @returns such as `/guide/safety-and-updates/trust` or `/zh/reference/parity-with-deepseek-harness/divergence`.
 */
export function routeOf(section: Section, slugs: readonly string[], chinese: boolean): string {
  return [chinese ? '/zh' : '', section, ...slugs].join('/')
}

/**
 * The site route of the changelog page, which exists only when the build published a changelog record.
 * @param chinese - whether the page is the Chinese half.
 * @returns `/changelog` or `/zh/changelog`.
 */
export function changelogRoute(chinese: boolean): string {
  return chinese ? '/zh/changelog' : '/changelog'
}

/**
 * The site route of the roadmap, a guide page that the header links instead of the sidebar.
 * @param chinese - whether the page is the Chinese half.
 * @returns `/guide/roadmap` or `/zh/guide/roadmap`.
 */
export function roadmapRoute(chinese: boolean): string {
  return routeOf('guide', ['roadmap'], chinese)
}
