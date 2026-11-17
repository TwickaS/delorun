import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DOCS_URL } from '../src/site/config.ts'
import { CONSENT_TEXT, CONSENT_TEXT_VERSION, HOME_SIGNUP_PAGE, SIGNUP_PAGES } from '../src/site/signup.ts'
import { COPY } from '../src/site/copy.ts'
import { EN } from '../src/site/words/en.ts'

/** The guide pages the documentation site builds from. */
const GUIDE = new URL('../../../docs/guide/', import.meta.url)

/**
 * Every string a dictionary holds, functions called with sample values.
 * @param value - the dictionary or a part of it.
 * @returns the strings.
 */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (typeof value === 'function') return [String(value('0.1.0', '2026-11-17'))]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(strings)
  return []
}

/**
 * A heading's id as the documentation site makes it.
 * @param heading - the heading text.
 * @returns the id.
 */
function slug(heading: string): string {
  return heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-')
}

/** The parts of the dictionary the home page shows (the desktop button appears twice by design). */
const HOME = { hero: EN.hero, claims: EN.claims, sections: EN.sections, whatsNew: EN.whatsNew, next: EN.next, closing: EN.closing, signup: { heading: EN.signup.heading, text: EN.signup.text, consent: EN.signup.consent.text, submit: EN.signup.submit } }

describe('the page’s words', () => {
  it('link only guide pages and headings that exist', () => {
    const links = strings(EN).filter(text => text.startsWith(`${DOCS_URL}/guide/`))
    expect(links.length).toBeGreaterThan(10)
    for (const link of links) {
      const url = new URL(link)
      const page = new URL(`${url.pathname.slice('/guide/'.length)}.md`, GUIDE)
      expect(existsSync(page), `${link}: no guide page`).toBe(true)
      if (url.hash === '') continue
      const ids = readFileSync(page, 'utf8').split('\n').filter(line => /^#{2,4} /.test(line)).map(line => slug(line.replace(/^#+ /, '')))
      expect(ids, `${link}: no such heading`).toContain(url.hash.slice(1))
    }
  })

  it('carry five numbered claims, one sentence each, each with its guide page', () => {
    expect(COPY.claims.items).toHaveLength(5)
    for (const claim of COPY.claims.items) {
      expect(claim.text.match(/[.!?](\s|$)/g), claim.text).toHaveLength(1)
      expect(claim.href.startsWith(`${DOCS_URL}/guide/`)).toBe(true)
    }
  })

  it('use no dash in visible text', () => {
    for (const text of strings(EN).filter(each => !/^(https?:|mailto:)/.test(each))) {
      expect(text, text).not.toMatch(/[–—]| - /)
    }
  })

  it('say no sentence twice on the home page', () => {
    const sentences = strings(HOME).filter(each => !/^(https?:|mailto:)/.test(each)).flatMap(text => text.split(/(?<=[.!?])\s+/)).map(each => each.trim()).filter(each => each.length > 12)
    const seen = new Set<string>()
    for (const sentence of sentences) {
      expect(seen.has(sentence), `said twice: ${sentence}`).toBe(false)
      seen.add(sentence)
    }
  })

  it('keep the limits beside the promises', () => {
    const claims = COPY.claims.items.map(claim => claim.text)
    expect(claims[1]).toMatch(/not the files an agent changed/)
    expect(claims[2]).toMatch(/your own Tailscale network/)
    expect(`${COPY.hero.platform.before}${COPY.hero.platform.linkText}`).toBe('Runs on Linux and on Windows through WSL2')
    expect(strings(HOME).join(' ')).not.toMatch(/undo everything|every provider|\d+ providers/i)
  })
})

describe('the sign-up consent', () => {
  it('comes from the dictionary with its raised version', () => {
    expect(CONSENT_TEXT).toBe(EN.signup.consent.text)
    expect(CONSENT_TEXT_VERSION).toBe('2')
  })

  it('records the home page as a page the Worker accepts', () => {
    expect(SIGNUP_PAGES).toContain(HOME_SIGNUP_PAGE)
    expect(HOME_SIGNUP_PAGE).toBe('/')
    expect(SIGNUP_PAGES).toEqual(['/', '/privacy', '/notices', '/blog'])
  })
})
