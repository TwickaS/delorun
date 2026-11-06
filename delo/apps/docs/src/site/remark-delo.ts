/**
 * The remark transform every Delo page passes through at build time: relative links resolve to routes, upstream files,
 * or code text (see {@link resolveLink}), and a Chinese page's headings take the English page's ids.
 *
 * @module @delo/docs/remark-delo
 */
import type { Heading, Link, Root, RootContent } from 'mdast'
import { englishHeadingIds, repositoryRoot, resolveLink } from './doc-links.ts'

/** The file a remark transform runs for: the page's absolute path. */
interface PageFile {
  readonly path?: string | undefined
}

/**
 * A remark plugin that rewrites the page's relative links and, for a Chinese page, its heading ids.
 * @returns the transform; it throws on a link that names no file, so the build fails.
 */
export function remarkDelo(): (tree: Root, file: PageFile) => void {
  return (tree, file) => {
    const path = file.path
    if (path === undefined) throw new Error('docs-site: a page reached the build without its path')
    const root = repositoryRoot()
    const englishIds = /\.zh\.md$/.test(path) ? englishHeadingIds(path.replace(/\.zh\.md$/, '.md')) : undefined
    let heading = 0
    const visit = (node: RootContent | Root): void => {
      if (node.type === 'link') rewrite(node, path, root)
      if (node.type === 'heading' && englishIds !== undefined) setId(node, englishIds[heading++], path)
      if ('children' in node) for (const child of node.children) visit(child)
    }
    visit(tree)
  }
}

/**
 * Rewrite one link in place: a route or upstream URL, or code text for an unpublished Delo file.
 * @param node - the link.
 * @param path - the page's absolute path.
 * @param root - the repository root.
 */
function rewrite(node: Link, path: string, root: string): void {
  const resolved = resolveLink(path, node.url, root)
  if (resolved.kind === 'href') {
    node.url = resolved.href
    return
  }
  // The page links no unpublished file: its path reads as code, which keeps the reference without a dead link.
  const code = { type: 'inlineCode' as const, value: resolved.path }
  Object.assign(node, code)
  delete (node as Partial<Link>).url
  delete (node as Partial<Link>).children
}

/**
 * Give a Chinese heading the English heading's id, by position: the two pages have the same heading structure.
 * @param node - the heading.
 * @param id - the English id at that position.
 * @param path - the page's absolute path, for the error.
 * @throws Error when the English page has no heading at that position.
 */
function setId(node: Heading, id: string | undefined, path: string): void {
  if (id === undefined) throw new Error(`docs-site: ${path} has more headings than its English pair`)
  node.data = { ...node.data, hProperties: { ...(node.data?.hProperties ?? {}), id } }
}
