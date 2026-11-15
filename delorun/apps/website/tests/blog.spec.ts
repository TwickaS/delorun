import { describe, expect, it } from 'vitest'
import { listArticles, parseArticle } from '../src/site/blog.ts'

const GOOD = '---\ntitle: Why Delorun exists\ndate: 2026-12-01\nsummary: The reason.\ncrosspost: https://example.com/post\n---\nBody text.\n'

describe('the blog article format', () => {
  it('parses front matter and body', () => {
    expect(parseArticle('2026-12-01-why-delorun-exists.md', GOOD)).toEqual({
      slug: 'why-delorun-exists', title: 'Why Delorun exists', date: '2026-12-01', summary: 'The reason.', crosspost: 'https://example.com/post', body: 'Body text.',
    })
  })

  it('treats crosspost as optional', () => {
    const article = parseArticle('2026-12-01-a.md', '---\ntitle: A\ndate: 2026-12-01\nsummary: S\n---\nB')
    expect('crosspost' in article).toBe(false)
  })

  it.each([
    ['a bad file name', 'Why.md', GOOD],
    ['no front matter', '2026-12-01-a.md', 'Body'],
    ['an unknown key', '2026-12-01-a.md', '---\ntitle: A\ndate: 2026-12-01\nsummary: S\ncolour: red\n---\nB'],
    ['a missing title', '2026-12-01-a.md', '---\ndate: 2026-12-01\nsummary: S\n---\nB'],
    ['a date that differs from the name', '2026-12-02-a.md', '---\ntitle: A\ndate: 2026-12-01\nsummary: S\n---\nB'],
    ['an insecure crosspost', '2026-12-01-a.md', '---\ntitle: A\ndate: 2026-12-01\nsummary: S\ncrosspost: http://x.example\n---\nB'],
  ])('refuses %s', (_name, file, raw) => {
    expect(() => parseArticle(file, raw)).toThrow(/Blog article/)
  })

  it('lists newest first, allows none and refuses a repeated slug', () => {
    expect(listArticles({})).toEqual([])
    const older = '---\ntitle: Old\ndate: 2026-01-01\nsummary: S\n---\nB'
    const newer = '---\ntitle: New\ndate: 2026-02-01\nsummary: S\n---\nB'
    expect(listArticles({ '/x/2026-01-01-old.md': older, '/x/2026-02-01-new.md': newer }).map(a => a.title)).toEqual(['New', 'Old'])
    expect(() => listArticles({ '/x/2026-01-01-same.md': older.replace('2026-01-01', '2026-01-01'), '/y/2026-02-01-same.md': newer })).toThrow(/share the slug/)
  })
})
