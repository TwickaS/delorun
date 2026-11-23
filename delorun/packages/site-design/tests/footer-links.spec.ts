import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LOOK_NAMES } from '../src/looks.ts'
import { SiteFooter } from '../src/site-footer.tsx'
import type { FooterCopy } from '../src/shell-copy.ts'

const copy: FooterCopy = {
  navLabel: 'Footer', owner: 'Published by Delorun',
  licence: { label: 'MIT licence', href: '/licence' }, upstream: { label: 'Built on DeepSeek Harness', href: '/upstream' },
  theme: { open: 'Open', title: 'Look', themes: 'Theme', scheme: 'Mode', device: 'System', light: 'Light', dark: 'Dark', back: 'Back', current: name => name, names: LOOK_NAMES, toast: { region: 'N', theme: name => name, scheme: name => name, undo: name => name, reset: 'R' } },
}

describe('the footer\'s links', () => {
  const html = renderToStaticMarkup(createElement(SiteFooter, { copy, links: [{ label: 'Docs', href: '/docs' }] }))

  it('give the list links a 44 px box and the small owner-line links at least a 24 px box', () => {
    expect(html).toMatch(/<li class="[^"]*min-h-11[^"]*"><a[^>]*>Docs/)
    expect(html).toMatch(/<a[^>]*class="[^"]*min-h-6[^"]*"[^>]*>MIT licence/)
    expect(html).toMatch(/<a[^>]*class="[^"]*min-h-6[^"]*"[^>]*>Built on DeepSeek Harness/)
  })
})
