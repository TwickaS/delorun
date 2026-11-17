/**
 * Styles of a prerendered page. A page shown with scripts off needs every class its markup uses to have a rule in a
 * stylesheet the page links, so this module finds the classes that have none, and links the stylesheet of a chunk the
 * prerender renders but the browser loads on demand (a chunk's CSS is not linked from the page by the build).
 *
 * @module @delorun/website/scripts/styles
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The stylesheets a page links.
 * @param html - the page.
 * @returns the hrefs, as written.
 */
export function linkedStyles(html: string): string[] {
  return [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map(match => match[1] ?? '')
}

/**
 * The classes the markup uses that no linked stylesheet has a rule for.
 * @param out - the built directory.
 * @param page - the page's file name in it, such as `index.html`.
 * @returns the class names, sorted; empty when every class is styled.
 */
export function unstyledClasses(out: string, page: string): string[] {
  const html = readFileSync(join(out, page), 'utf8')
  const css = linkedStyles(html).map(href => readFileSync(join(out, href), 'utf8')).join('\n')
  const styled = new Set([...css.matchAll(/\.((?:\\.|[\w-])+)/g)].map(match => (match[1] ?? '').replace(/\\(.)/g, '$1')))
  const used = new Set([...html.matchAll(/\sclass="([^"]*)"/g)].flatMap(match => (match[1] ?? '').split(/\s+/)).filter(name => name !== ''))
  return [...used].filter(name => !styled.has(name)).sort()
}

/**
 * Links the stylesheets of chunks a page renders on the server but the browser loads later.
 * @param out - the built directory.
 * @param chunks - by page file name, the chunk names (the file name before the hash) whose stylesheets the page needs.
 * @throws Error when a named chunk has no stylesheet, so a renamed chunk cannot silently stop being linked.
 */
export function linkChunkStyles(out: string, chunks: Readonly<Record<string, readonly string[]>>): void {
  const assets = join(out, 'assets')
  const files = existsSync(assets) ? readdirSync(assets) : []
  for (const [page, names] of Object.entries(chunks)) {
    const path = join(out, page)
    if (!existsSync(path)) continue
    let html = readFileSync(path, 'utf8')
    const linked = new Set(linkedStyles(html))
    const links: string[] = []
    for (const name of names) {
      const found = files.filter(file => file.startsWith(`${name}-`) && file.endsWith('.css'))
      if (found.length === 0) throw new Error(`${page}: no stylesheet for the chunk "${name}" in ${assets}; rename it in config.ts or remove it`)
      for (const file of found) if (!linked.has(`/assets/${file}`)) links.push(`<link rel="stylesheet" href="/assets/${file}"/>`)
    }
    if (links.length > 0) {
      html = html.replace('</head>', `${links.join('')}</head>`)
      writeFileSync(path, html)
    }
  }
}
