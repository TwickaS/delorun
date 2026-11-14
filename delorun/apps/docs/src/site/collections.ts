/**
 * The page collections, one per section, read in place from Delorun's pages: `<name>.md` and its Chinese pair
 * `<name>.zh.md` beside it. The `.i18n.yaml` consistency records are not matched. Each collection bundles the pages'
 * frontmatter and loads a page's compiled content on demand from the built assets, so a link followed in the browser
 * renders the next page without asking a server.
 *
 * @module @delorun/docs/collections
 */
import { defineDocs } from 'fumadocs-mdx/macro'
import { z } from 'zod'
import { firstHeading } from './headings.ts'

/**
 * The frontmatter of a page. A page carries its title as its first heading, so a page without a frontmatter title
 * takes that heading's text, which the sidebar, the document title and the search index show.
 * @param context - the page being compiled.
 * @param context.source - the page's Markdown.
 * @returns the frontmatter schema for that page.
 */
function pageFrontmatter({ source }: { source: string }) {
  return z.object({
    title: z.string().optional(),
    description: z.string().optional(),
  }).transform(frontmatter => ({ ...frontmatter, title: frontmatter.title ?? firstHeading(source) }))
}

/** The user guide's pages. */
export const guide = defineDocs({
  dir: '../../docs/guide',
  docs: { async: true, schema: pageFrontmatter },
})

/** The references' pages. */
export const reference = defineDocs({
  dir: '../../docs/reference',
  docs: { async: true, schema: pageFrontmatter },
})
