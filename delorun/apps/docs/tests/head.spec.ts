import { describe, expect, it } from 'vitest'
import { pageHead } from '../src/site/head.ts'

describe('the page head', () => {
  it('carries the description, the canonical address and the link-preview data', () => {
    const head = pageHead({ title: 'Trust', description: 'What you trust.', path: '/guide/safety-and-updates/trust', locale: 'en' })
    expect(head.links).toEqual([{ rel: 'canonical', href: 'https://docs.delorun.com/guide/safety-and-updates/trust' }])
    expect(head.meta).toContainEqual({ name: 'description', content: 'What you trust.' })
    expect(head.meta).toContainEqual({ property: 'og:url', content: 'https://docs.delorun.com/guide/safety-and-updates/trust' })
    expect(head.meta).toContainEqual({ property: 'og:locale', content: 'en_GB' })
    expect(head.meta).toContainEqual({ property: 'og:site_name', content: 'Delorun Docs' })
  })

  it('leaves out the description when the page has none, and names the Chinese locale', () => {
    const head = pageHead({ title: 'T', description: undefined, path: '/zh', locale: 'zh' })
    expect(head.meta.some(entry => 'name' in entry && entry.name === 'description')).toBe(false)
    expect(head.meta).toContainEqual({ property: 'og:locale', content: 'zh_CN' })
    expect(head.meta).toContainEqual({ property: 'og:site_name', content: 'Delorun 文档' })
  })
})
