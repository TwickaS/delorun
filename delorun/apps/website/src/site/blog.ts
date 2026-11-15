/**
 * The blog's article format and the list the `/blog` index shows. An article is one Markdown file in
 * `content/blog/`, named `YYYY-MM-DD-slug.md`, that starts with a front matter block of `key: value` lines:
 *
 * ```text
 * ---
 * title: Why Delorun exists
 * date: 2026-12-01
 * summary: One sentence that the index shows under the title.
 * crosspost: https://example.com/the-copy-on-a-developer-platform
 * ---
 * The article, in Markdown.
 * ```
 *
 * `title`, `date` and `summary` are required. `crosspost` is optional: the address of the copy on a developer
 * platform that points back to the original.
 *
 * @module @delorun/website/blog
 */

/** One article: its front matter and its Markdown body. */
export interface Article {
  /** The file name without `.md`, which is also the article's address under `/blog/`. */
  readonly slug: string
  readonly title: string
  /** The publication date, `YYYY-MM-DD`. */
  readonly date: string
  readonly summary: string
  /** The address of the copy on a developer platform, when there is one. */
  readonly crosspost?: string
  readonly body: string
}

const FILE_NAME = /^(\d{4}-\d{2}-\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/
const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/
const KNOWN_KEYS = new Set(['title', 'date', 'summary', 'crosspost'])

/**
 * Parses one article file.
 * @param fileName - the file's name, such as `2026-12-01-why-delorun-exists.md`.
 * @param raw - the file's text.
 * @returns the article.
 * @throws when the name or the front matter does not follow the format; a malformed article stops the build.
 */
export function parseArticle(fileName: string, raw: string): Article {
  const named = FILE_NAME.exec(fileName)
  if (named === null) throw new Error(`Blog article "${fileName}": the name must be YYYY-MM-DD-slug.md with a lower-case slug.`)
  const nameDate = named[1] ?? ''
  const slug = named[2] ?? ''
  const parts = FRONT_MATTER.exec(raw.replace(/\r\n/g, '\n'))
  if (parts === null) throw new Error(`Blog article "${fileName}": the file must start with a front matter block between two --- lines.`)
  const fields = new Map<string, string>()
  for (const line of (parts[1] ?? '').split('\n')) {
    const colon = line.indexOf(':')
    const key = colon < 0 ? '' : line.slice(0, colon).trim()
    if (!KNOWN_KEYS.has(key)) throw new Error(`Blog article "${fileName}": unknown or malformed front matter line "${line}".`)
    fields.set(key, line.slice(colon + 1).trim())
  }
  const need = (key: string): string => {
    const value = fields.get(key)
    if (value === undefined || value === '') throw new Error(`Blog article "${fileName}": front matter needs "${key}".`)
    return value
  }
  const date = need('date')
  if (date !== nameDate) throw new Error(`Blog article "${fileName}": the date "${date}" must match the date in the file name.`)
  const crosspost = fields.get('crosspost')
  if (crosspost !== undefined && !/^https:\/\/\S+$/.test(crosspost)) throw new Error(`Blog article "${fileName}": "crosspost" must be an https address.`)
  return { slug, title: need('title'), date, summary: need('summary'), ...(crosspost === undefined ? {} : { crosspost }), body: (parts[2] ?? '').trim() }
}

/**
 * Parses every article and orders them newest first.
 * @param files - the article files by path, as `import.meta.glob` returns them with `?raw`.
 * @returns the articles, newest first; empty when there are none.
 * @throws when two files share a slug or any file is malformed.
 */
export function listArticles(files: Readonly<Record<string, string>>): readonly Article[] {
  const articles = Object.entries(files).map(([path, raw]) => parseArticle(path.slice(path.lastIndexOf('/') + 1), raw))
  const seen = new Set<string>()
  for (const { slug } of articles) {
    if (seen.has(slug)) throw new Error(`Blog: two articles share the slug "${slug}".`)
    seen.add(slug)
  }
  return articles.sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug))
}
