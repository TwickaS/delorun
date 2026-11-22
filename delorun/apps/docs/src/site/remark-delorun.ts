/**
 * The remark transform every Delorun page passes through at build time: relative links resolve to routes, upstream files
 * or Delorun files on GitHub (see {@link resolveLink}), a Chinese page's headings take the English page's ids, and a folded
 * `<details>` block (see {@link foldDetails}) becomes a `details` element holding its Markdown, and an inline anchor
 * `<a id="…"></a>` (see {@link keepAnchors}) becomes an empty element that keeps its id.
 *
 * @module @delorun/docs/remark-delorun
 */
import type { BlockContent, Heading, Html, Link, Parent, Root, RootContent } from 'mdast'
import { englishHeadingIds, repositoryRoot, resolveLink } from './doc-links.ts'

/** The file a remark transform runs for: the page's absolute path. */
interface PageFile {
  readonly path?: string | undefined
}

/**
 * A remark plugin that rewrites the page's relative links and, for a Chinese page, its heading ids.
 * @returns the transform; it throws on a link that names no file, so the build fails.
 */
export function remarkDelorun(): (tree: Root, file: PageFile) => void {
  return (tree, file) => {
    const path = file.path
    if (path === undefined) throw new Error('docs-site: a page reached the build without its path')
    const root = repositoryRoot()
    const englishIds = /\.zh\.md$/.test(path) ? englishHeadingIds(path.replace(/\.zh\.md$/, '.md')) : undefined
    dropLanguageLine(tree)
    let heading = 0
    const visit = (node: RootContent | Root): void => {
      if ('children' in node && node.type !== 'paragraph' && node.type !== 'heading') foldDetails(node, path)
      if ('children' in node) keepAnchors(node)
      if (node.type === 'link') rewrite(node, path, root)
      if (node.type === 'heading' && englishIds !== undefined) setId(node, englishIds[heading++], path)
      if ('children' in node) for (const child of node.children) visit(child)
    }
    visit(tree)
  }
}

/**
 * Remove the paragraph that names a page's only language, such as a bare `English` line under the title of a page with
 * no Chinese twin. The Markdown keeps the line, which the doc gates read; the site renders the page without it.
 * @param tree - the page's root; the paragraph is removed from its top-level children.
 */
export function dropLanguageLine(tree: Root): void {
  tree.children = tree.children.filter(node => !isBareLanguageName(node))
}

/** A paragraph whose only content is one language name. */
function isBareLanguageName(node: RootContent): boolean {
  return node.type === 'paragraph' && node.children.length === 1 && node.children[0]?.type === 'text' && node.children[0].value.trim() === 'English'
}

/**
 * Rewrite one link in place: a route, or a file's URL in the upstream or the Delorun repository.
 * @param node - the link.
 * @param path - the page's absolute path.
 * @param root - the repository root.
 */
function rewrite(node: Link, path: string, root: string): void {
  node.url = resolveLink(path, node.url, root).href
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

/** An HTML block that opens a folded block: `<details>` and its `<summary>` line, as the guide writes them. */
const DETAILS_OPEN = /^<details(?<open>\s+open)?>\s*<summary>(?<summary>[^<]*)<\/summary>\s*$/u

/**
 * Turn each folded block in a node's children into one `details` element: the HTML block that opens it, the Markdown
 * that follows and the HTML block `</details>` become a node that renders as `<details><summary>…</summary>…</details>`,
 * so the Markdown inside is rendered, not dropped as raw HTML. The block is not nested: its content ends at the first
 * `</details>`.
 * @param parent - the node whose children are scanned.
 * @param path - the page's absolute path, for the error.
 * @throws Error when a `<details>` block is not closed.
 */
function foldDetails(parent: Parent, path: string): void {
  const children = parent.children as RootContent[]
  for (let index = 0; index < children.length; index++) {
    const child = children[index]
    if (child?.type !== 'html') continue
    const opened = DETAILS_OPEN.exec((child as Html).value.trim())
    if (opened?.groups === undefined) continue
    const close = children.findIndex((candidate, at) => at > index && candidate.type === 'html' && (candidate as Html).value.trim() === '</details>')
    if (close === -1) throw new Error(`docs-site: ${path} has a <details> block with no closing </details> block`)
    const summary: BlockContent = { type: 'paragraph', children: [{ type: 'text', value: opened.groups.summary ?? '' }], data: { hName: 'summary' } }
    const folded: RootContent = {
      type: 'blockquote',
      children: [summary, ...(children.slice(index + 1, close) as BlockContent[])],
      data: { hName: 'details', hProperties: opened.groups.open === undefined ? {} : { open: true } },
    }
    children.splice(index, close - index + 1, folded)
  }
}

/** The opening tag of an inline HTML anchor with only an id, as the glossary writes after each entry. */
const INLINE_ANCHOR = /^<a id="(?<id>[^"]+)">$/u

/**
 * Replace each inline `<a id="…"></a>` in a node's children with an empty element that carries the id, so links to
 * the anchor resolve; raw inline HTML is otherwise dropped from the page.
 * @param parent - the node whose children are scanned.
 */
function keepAnchors(parent: Parent): void {
  const children = parent.children as RootContent[]
  for (let index = 0; index < children.length; index++) {
    const child = children[index]
    if (child?.type !== 'html') continue
    const id = INLINE_ANCHOR.exec((child as Html).value.trim())?.groups?.id
    const close = children[index + 1]
    if (id === undefined || close?.type !== 'html' || (close as Html).value.trim() !== '</a>') continue
    children.splice(index, 2, { type: 'emphasis', children: [], data: { hName: 'span', hProperties: { id } } })
  }
}
