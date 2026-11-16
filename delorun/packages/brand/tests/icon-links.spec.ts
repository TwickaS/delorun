/** The tab icon tags: the studio's static page carries the same ones the helper writes. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { iconLinkTags } from '../src/icon-links.ts'

describe('the tab icon tags', () => {
  it('list a plain SVG first, the themed variants after it, and the ICO last', () => {
    const tags = iconLinkTags({ fallback: '/a.svg', light: '/l.svg', dark: '/d.svg', ico: '/f.ico' }).split('\n')
    expect(tags).toEqual([
      '<link rel="icon" type="image/svg+xml" href="/a.svg">',
      '<link rel="icon" type="image/svg+xml" href="/d.svg" media="(prefers-color-scheme: dark)">',
      '<link rel="icon" type="image/svg+xml" href="/l.svg" media="(prefers-color-scheme: light)">',
      '<link rel="icon" href="/f.ico" sizes="any">',
    ])
    expect(iconLinkTags({ fallback: '/a.svg', light: '/l.svg', dark: '/d.svg' }).split('\n')).toHaveLength(3)
  })

  it('are what apps/web/index.html holds, with the media-free fallback and the ICO', () => {
    const html = readFileSync(new URL('../../../../apps/web/index.html', import.meta.url), 'utf8')
    const expected = iconLinkTags({ fallback: '/favicon.svg', light: '/favicon.svg', dark: '/favicon-dark.svg', ico: '/favicon.ico' })
    // The page writes the tags with indentation and self-closing slashes; the same tags in the same order.
    const found = [...html.matchAll(/<link rel="icon"[^>]*>/g)].map(match => match[0].replace(/ \/>$/, '>'))
    expect(found).toEqual(expected.split('\n'))
  })

  it('is the Delorun name in the web manifest, not the upstream product', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../../../apps/web/public/manifest.webmanifest', import.meta.url), 'utf8')) as { name: string, short_name: string }
    expect([manifest.name, manifest.short_name]).toEqual(['Delorun', 'Delorun'])
  })
})
