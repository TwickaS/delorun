/**
 * Link resolution and heading ids for Delo's pages, shared by the build's Markdown plugins and the Markdown routes.
 * Every relative link in `delo/docs/guide` and `delo/docs/reference` resolves here: a published page becomes its site
 * route, an upstream repository file becomes its upstream URL, a Delo file outside the published pages becomes code
 * text, and a target that exists nowhere fails the build.
 *
 * @module @delo/docs/doc-links
 */
import { existsSync, readFileSync } from 'node:fs'
import { posix, relative, resolve, sep } from 'node:path'
import GithubSlugger from 'github-slugger'

/** The upstream repository's default-branch URL prefix, for upstream files that Delo's pages link. */
export const UPSTREAM_BLOB_URL = 'https://github.com/deepseek-ai/deepseek-harness/blob/master/'

/** The published section names, which are also the first route segment. */
export type Section = 'guide' | 'reference'

/** How a link resolves. */
export type ResolvedLink =
  | { readonly kind: 'href', readonly href: string }
  | { readonly kind: 'unpublished', readonly path: string }

/**
 * Whether a string names a published section.
 * @param value - the candidate name.
 * @returns true for `guide` and `reference`.
 */
export function isSection(value: string): value is Section {
  return value === 'guide' || value === 'reference'
}

/** The directory each published section reads from, relative to the repository root. */
const PAGE_ROOT = 'delo/docs'

/**
 * The repository root, from the site's working directory `delo/apps/docs`.
 * @returns the absolute path of the repository root.
 * @throws Error when the site is not run from `delo/apps/docs`.
 */
export function repositoryRoot(): string {
  const root = resolve(process.cwd(), '../../..')
  if (!existsSync(resolve(root, 'pnpm-workspace.yaml'))) throw new Error(`docs-site: run the site from delo/apps/docs; ${process.cwd()} does not lie in the repository`)
  return root
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
 * The site route of a published page.
 * @param section - the section, `guide` or `reference`.
 * @param slugs - the page's slugs within its section.
 * @param chinese - whether the page is the Chinese half.
 * @returns such as `/guide/trust` or `/zh/reference/divergence`.
 */
export function routeOf(section: Section, slugs: readonly string[], chinese: boolean): string {
  return [chinese ? '/zh' : '', section, ...slugs].join('/')
}

/**
 * Resolve one link of a published page. A link to a published page takes the locale its target names, by the `.zh.md`
 * or `.md` suffix.
 * @param filePath - the absolute path of the page holding the link.
 * @param href - the link target as written, possibly with a fragment.
 * @param root - the repository root, from {@link repositoryRoot}.
 * @returns the URL to write into the page, or the code text that replaces a link to an unpublished Delo file.
 * @throws Error naming the page and the link when the target exists nowhere, or when it is a page in the other locale's missing pair.
 */
export function resolveLink(filePath: string, href: string, root: string): ResolvedLink {
  if (href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return { kind: 'href', href }
  const hash = href.indexOf('#')
  const pathPart = hash === -1 ? href : href.slice(0, hash)
  const fragment = hash === -1 ? '' : href.slice(hash)
  const pageRel = relative(root, filePath).split(sep).join('/')
  const target = posix.normalize(posix.join(posix.dirname(pageRel), pathPart))
  const fail = (reason: string): never => {
    throw new Error(`docs-site: ${pageRel}: link "${href}" ${reason}`)
  }
  if (target.startsWith('../')) fail('leaves the repository')
  const pageDir = `${PAGE_ROOT}/`
  if (target.startsWith(pageDir)) {
    const inside = target.slice(pageDir.length)
    const section = inside.split('/')[0]
    if (!isSection(section)) return publishedOrUnpublished(root, target, fail, fragment)
    const within = inside.slice(section.length + 1)
    // The target's own suffix names its locale: a `.zh.md` link is Chinese, and a `.md` link is English, including a
    // Chinese page's switcher back to English.
    if (!existsSync(resolve(root, target))) fail('names no page in this section')
    return { kind: 'href', href: `${routeOf(section, slugsOf(within), /\.zh\.md$/.test(within))}${fragment}` }
  }
  return publishedOrUnpublished(root, target, fail, fragment)
}

/**
 * A target outside the published sections: a Delo file becomes code text, and an upstream file becomes its upstream URL.
 * @param root - the repository root.
 * @param target - the repository-relative target.
 * @param fail - raises the error for a target that exists nowhere.
 * @param fragment - the target's fragment, with its `#`, which an upstream URL keeps.
 * @returns the resolved link.
 */
function publishedOrUnpublished(root: string, target: string, fail: (reason: string) => never, fragment = ''): ResolvedLink {
  if (!existsSync(resolve(root, target))) fail('names no file in the repository')
  if (target.startsWith('delo/')) return { kind: 'unpublished', path: target }
  return { kind: 'href', href: `${UPSTREAM_BLOB_URL}${target}${fragment}` }
}

/**
 * The slugs of a page's headings in document order, as the English page's ids. A Chinese page's heading ids take these,
 * so its table-of-contents links, which the consistency record requires to name the English anchors, resolve.
 * @param englishPath - the absolute path of the English page.
 * @returns one id per heading, in order.
 */
export function englishHeadingIds(englishPath: string): string[] {
  const slugger = new GithubSlugger()
  const ids: string[] = []
  let fence = false
  for (const line of readFileSync(englishPath, 'utf8').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    if (fence) continue
    const match = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)
    if (match === null) continue
    ids.push(slugger.slug(plainText(match[1] ?? '')))
  }
  return ids
}

/**
 * The text a heading shows, without its inline Markdown.
 * @param markdown - the heading's inline Markdown.
 * @returns the text, which the slugger turns into the id.
 */
export function plainText(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
}
