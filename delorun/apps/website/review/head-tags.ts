/**
 * The head tags of a page, read from the served HTML: title, description, canonical address, link-preview tags and
 * structured data. Each is reported present or missing so a reviewer sees what a share or a search result would show.
 *
 * @module @delorun/website/review/head-tags
 */
import type { Finding } from './report.ts'

/** The tags checked, in report order. */
export const TAGS = ['title', 'description', 'canonical', 'og:title', 'og:description', 'og:image', 'og:image:alt', 'og:url', 'og:type', 'og:site_name', 'twitter:card', 'twitter:title', 'twitter:description', 'twitter:image', 'twitter:image:alt', 'structured-data'] as const

/** A tag's name. */
export type TagName = (typeof TAGS)[number]

/** What one page's head holds: the value of each tag, or `null` when it is missing. */
export type HeadTags = Readonly<Record<TagName, string | null>>

const attribute = (tag: string, name: string): string | null => new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag)?.[1] ?? new RegExp(`\\s${name}\\s*=\\s*'([^']*)'`, 'i').exec(tag)?.[1] ?? null

/**
 * Reads the head tags from HTML.
 * @param html - the page's HTML.
 * @returns each tag's value, or `null` when missing or empty.
 */
export function readHeadTags(html: string): HeadTags {
  const head = /<head[\s\S]*?<\/head>/i.exec(html)?.[0] ?? html
  const metas = [...head.matchAll(/<meta\b[^>]*>/gi)].map(match => match[0])
  const meta = (key: string): string | null => {
    for (const tag of metas) {
      const name = attribute(tag, 'name') ?? attribute(tag, 'property')
      if (name === key) {
        const content = attribute(tag, 'content')
        return content === null || content.trim() === '' ? null : content
      }
    }
    return null
  }
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1]?.trim()
  const canonical = [...head.matchAll(/<link\b[^>]*>/gi)].map(match => match[0]).find(tag => attribute(tag, 'rel') === 'canonical')
  const blocks = [...html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1] ?? '')
  let structured: string | null = null
  if (blocks.length > 0) {
    try {
      structured = blocks.map(block => (JSON.parse(block) as { '@type'?: string })['@type'] ?? 'untyped').join(', ')
    } catch {
      structured = 'invalid JSON'
    }
  }
  return {
    'title': title === undefined || title === '' ? null : title,
    'description': meta('description'),
    'canonical': canonical === undefined ? null : attribute(canonical, 'href'),
    'og:title': meta('og:title'), 'og:description': meta('og:description'), 'og:image': meta('og:image'), 'og:image:alt': meta('og:image:alt'), 'og:url': meta('og:url'), 'og:type': meta('og:type'), 'og:site_name': meta('og:site_name'),
    'twitter:card': meta('twitter:card'), 'twitter:title': meta('twitter:title'), 'twitter:description': meta('twitter:description'), 'twitter:image': meta('twitter:image'), 'twitter:image:alt': meta('twitter:image:alt'),
    'structured-data': structured,
  }
}

/**
 * Whether a page is meant to carry a tag: the 404 page is `noindex` with no canonical address or `og:url`, and structured
 * data sits on the home page only.
 * @param page - the page's name.
 * @param name - the tag.
 * @returns true when a missing tag is a finding.
 */
export function expected(page: string, name: TagName): boolean {
  if (page === '404' && (name === 'canonical' || name === 'og:url')) return false
  if (name === 'structured-data') return page === 'home'
  return true
}

/**
 * Findings for one page's tags: a warning for each missing tag and for invalid structured data.
 * @param page - the page's name.
 * @param tags - its tags.
 * @returns the findings.
 */
export function headFindings(page: string, tags: HeadTags): Finding[] {
  return TAGS.flatMap((name): Finding[] => {
    if (!expected(page, name)) return []
    const value = tags[name]
    if (value === null) return [{ severity: 'warn', check: 'head-tags', where: page, message: `${name} is missing` }]
    if (name === 'structured-data' && value === 'invalid JSON') return [{ severity: 'fail', check: 'head-tags', where: page, message: 'structured data is not valid JSON' }]
    return []
  })
}

/**
 * Fetches the five pages and reads their head tags.
 * @param base - the server's origin.
 * @returns the tags by page name and the findings.
 */
export async function headTags(base: string): Promise<{ tags: Record<string, HeadTags>; findings: Finding[] }> {
  const tags: Record<string, HeadTags> = {}
  const findings: Finding[] = []
  for (const [name, path] of [['home', '/'], ['privacy', '/privacy'], ['notices', '/notices'], ['blog', '/blog'], ['404', '/__qa-missing']] as const) {
    tags[name] = readHeadTags(await (await fetch(new URL(path, base))).text())
    findings.push(...headFindings(name, tags[name]))
  }
  return { tags, findings }
}
