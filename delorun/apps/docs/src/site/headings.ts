/**
 * Heading text in Delorun's pages. These functions read no file, so the page collections, which the browser also loads,
 * and the build's link resolution both use them.
 *
 * @module @delorun/docs/headings
 */

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

/**
 * The text of a page's first level-one heading, outside code blocks.
 * @param markdown - the page's Markdown.
 * @returns the heading's text, or undefined when the page has none.
 */
export function firstHeading(markdown: string): string | undefined {
  let fence = false
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    if (fence) continue
    const match = /^#\s+(.*?)\s*#*\s*$/.exec(line)
    if (match !== null) return plainText(match[1] ?? '').trim()
  }
  return undefined
}
