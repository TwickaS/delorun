// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DesktopButton, desktopOffer, detectPlatform, isAllowedDownload } from '../src/components/desktop-button.tsx'
import { DESKTOP_DOWNLOADS, DESKTOP_PLATFORMS } from '../src/site/config.ts'
import { COPY } from '../src/site/copy.ts'
import { ROADMAP_DESKTOP_HREF } from '../src/site/words/en.ts'

const NONE = { macos: '', windows: '' } as const

/**
 * Parses a server render into a document, so the test reads elements rather than text.
 * @param html - the markup.
 * @returns the document's body.
 */
function parse(html: string): HTMLElement {
  return new DOMParser().parseFromString(html, 'text/html').body
}

describe('the desktop download button', () => {
  it('is unavailable while every address in the configuration is empty, and never enabled without one', () => {
    for (const platform of [undefined, ...DESKTOP_PLATFORMS]) {
      const offer = desktopOffer(DESKTOP_DOWNLOADS, platform)
      if (offer.available) expect(DESKTOP_DOWNLOADS[offer.platform].trim()).not.toBe('')
    }
    const body = parse(renderToStaticMarkup(createElement(DesktopButton)))
    const button = body.querySelector('button')!
    const configured = DESKTOP_PLATFORMS.some(platform => DESKTOP_DOWNLOADS[platform].trim() !== '')
    expect(button.getAttribute('aria-disabled')).toBe(configured ? null : 'true')
    if (!configured) expect([...body.querySelectorAll('a')].map(link => link.getAttribute('href'))).toEqual([ROADMAP_DESKTOP_HREF])
  })

  it('stays a focusable button described by its note, which links the roadmap entry', () => {
    const body = parse(renderToStaticMarkup(createElement(DesktopButton, { downloads: NONE })))
    const button = body.querySelector('button')!
    expect(button.hasAttribute('disabled')).toBe(false)
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.textContent).toBe(COPY.desktop.label)
    expect(button.getAttribute('type')).toBe('button')
    expect(button.closest('form, a')).toBeNull()
    const note = body.ownerDocument.getElementById(button.getAttribute('aria-describedby')!)!
    expect(note.textContent).toBe(`${COPY.desktop.note.before}${COPY.desktop.note.linkText}${COPY.desktop.note.after}`)
    expect(note.querySelector('a')!.getAttribute('href')).toBe(ROADMAP_DESKTOP_HREF)
  })

  it('turns on for a platform once its address is filled in, as a link to the whole address', () => {
    const downloads = { macos: '', windows: 'https://releases.delorun.com/desktop/0.1.0/Delorun.msi?v=1#sha' }
    expect(desktopOffer(downloads, 'macos')).toEqual({ available: true, platform: 'windows', href: downloads.windows })
    const body = parse(renderToStaticMarkup(createElement(DesktopButton, { downloads })))
    expect(body.querySelector('form, button')).toBeNull()
    const link = body.querySelector('a')!
    expect(link.getAttribute('href')).toBe(downloads.windows)
    expect(link.textContent).toBe(COPY.desktop.labelFor.windows)
  })

  it('offers only https addresses on the release host or the project’s GitHub releases', () => {
    for (const platform of DESKTOP_PLATFORMS) {
      const href = DESKTOP_DOWNLOADS[platform].trim()
      if (href !== '') expect(isAllowedDownload(href), `${platform}: ${href}`).toBe(true)
    }
    expect(isAllowedDownload('https://releases.delorun.com/desktop/Delorun.dmg')).toBe(true)
    expect(isAllowedDownload('https://github.com/twickas/delorun/releases/download/v0.1.0/Delorun.msi')).toBe(true)
    for (const refused of [
      'http://releases.delorun.com/desktop/Delorun.dmg',
      'ftp://releases.delorun.com/Delorun.dmg',
      'javascript:alert(1)',
      'https://releases.delorun.com.example.com/Delorun.dmg',
      'https://example.com/Delorun.msi',
      'https://user@releases.delorun.com/Delorun.dmg',
      'https://releases.delorun.com:8443/Delorun.dmg',
      'https://github.com/someone-else/delorun/releases/download/v0.1.0/Delorun.msi',
      'https://github.com/twickas/delorun/archive/main.zip',
      '/Delorun.dmg',
    ]) {
      expect(isAllowedDownload(refused), refused).toBe(false)
      expect(desktopOffer({ macos: refused, windows: '' }, 'macos')).toEqual({ available: false })
    }
  })

  it('prefers the visitor’s platform when it has a download', () => {
    const both = { macos: 'https://releases.delorun.com/Delorun.dmg', windows: 'https://releases.delorun.com/Delorun.msi' }
    expect(desktopOffer(both, 'windows')).toMatchObject({ platform: 'windows' })
    expect(desktopOffer(both, undefined)).toMatchObject({ platform: 'macos' })
    expect(desktopOffer({ macos: '  ', windows: '' }, 'macos')).toEqual({ available: false })
  })

  it('reads the platform from the user agent, and gives a phone none', () => {
    expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)')).toBe('macos')
    expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows')
    expect(detectPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBeUndefined()
    expect(detectPlatform('Mozilla/5.0 (X11; Linux x86_64)')).toBeUndefined()
  })
})

describe('the roadmap entry the note links', () => {
  it('is a heading on the roadmap page whose section names the desktop app for macOS and Windows', () => {
    const roadmap = readFileSync(resolve(import.meta.dirname, '../../../docs/guide/roadmap.md'), 'utf8')
    const fragment = new URL(ROADMAP_DESKTOP_HREF).hash.slice(1)
    const sections = roadmap.split(/^## /m)
    const section = sections.find(each => slug(each.split('\n')[0] ?? '') === fragment)
    expect(section, `no heading with the id "${fragment}" on the roadmap page`).toBeDefined()
    expect(section).toMatch(/\*\*The desktop app\.\*\* macOS and Windows/)
  })
})

/**
 * A heading's id as the documentation site makes it.
 * @param heading - the heading text.
 * @returns the id.
 */
function slug(heading: string): string {
  return heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-')
}
