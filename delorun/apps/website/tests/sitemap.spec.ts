import { describe, expect, it } from 'vitest'
import { sitemapPaths, sitemapXml } from '../src/site/sitemap.ts'

describe('the sitemap', () => {
  it('lists the blog index only once an article is published', () => {
    expect(sitemapPaths(['/', '/privacy'], 0)).toEqual(['/', '/privacy'])
    expect(sitemapPaths(['/', '/privacy'], 1)).toEqual(['/', '/privacy', '/blog'])
  })

  it('writes one absolute address per page', () => {
    expect(sitemapXml(['/', '/privacy'])).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>https://delorun.com/</loc></url>\n  <url><loc>https://delorun.com/privacy</loc></url>\n</urlset>\n')
  })
})
