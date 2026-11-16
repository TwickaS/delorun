import { describe, expect, it } from 'vitest'
import { pagePaths, sitemapXml } from '../src/site/sitemap.ts'

describe('the sitemap', () => {
  it('lists the pages and leaves out the 404 page, the indexes and the Markdown routes', () => {
    const paths = ['/', '/zh', '/404', '/llms.txt', '/zh/llms.txt', '/search.json', '/guide/trust', '/llms.mdx/guide/trust', '/zh/llms.mdx/guide/trust', '/zh/guide/trust']
    expect(pagePaths(paths)).toEqual(['/', '/zh', '/guide/trust', '/zh/guide/trust'])
  })

  it('writes one absolute address per page', () => {
    expect(sitemapXml(['/', '/guide/trust'])).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>https://docs.delorun.com/</loc></url>\n  <url><loc>https://docs.delorun.com/guide/trust</loc></url>\n</urlset>\n')
  })
})
