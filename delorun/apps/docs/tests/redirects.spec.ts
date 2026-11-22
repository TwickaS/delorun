import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { prerenderPaths } from '../src/site/pages.ts'
import { allRedirects, MOVED_PAGES, redirectsFile } from '../src/site/redirects.ts'

describe('the redirects of moved pages', () => {
  const paths = new Set(prerenderPaths(resolve(import.meta.dirname, '../../../..'), true))

  it('send every old address, in both locales and both routes, to a page the build publishes', () => {
    const redirects = allRedirects()
    expect(redirects).toHaveLength(MOVED_PAGES.length * 4)
    for (const { from, to } of redirects) expect(paths.has(to), `${from} -> ${to}`).toBe(true)
  })

  it('leave no old address as a published page', () => {
    for (const { from } of allRedirects()) expect(paths.has(from), from).toBe(false)
  })

  it('write one permanent redirect per line', () => {
    const lines = redirectsFile().split('\n').filter(line => line !== '' && !line.startsWith('#'))
    expect(lines).toHaveLength(MOVED_PAGES.length * 4)
    expect(lines).toContain('/guide/install /guide/get-started/install 301')
    expect(lines).toContain('/zh/llms.mdx/guide/trust /zh/llms.mdx/guide/safety-and-updates/trust 301')
    expect(lines).toContain('/llms.mdx/reference/divergence/index /llms.mdx/reference/parity-with-deepseek-harness/divergence/index 301')
    expect(lines.every(line => line.endsWith(' 301'))).toBe(true)
  })
})
