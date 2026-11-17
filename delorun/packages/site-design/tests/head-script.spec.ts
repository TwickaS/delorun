import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOOK_SCRIPT } from '../src/head-script.ts'
import { applyLook, currentLook, DEFAULT_LOOK, lookQuery, parseLook, withLook, type Look } from '../src/looks.ts'

/** A root element with the parts the script touches. */
function fakeRoot(dark = false) {
  const classes = new Set(dark ? ['dark'] : [])
  return {
    dataset: {} as Record<string, string>,
    classList: { toggle: (name: string, force?: boolean) => { if (force ?? !classes.has(name)) classes.add(name); else classes.delete(name); return classes.has(name) }, contains: (name: string) => classes.has(name) },
  }
}

/** Runs the head script on an address; returns the root and the address the page ends on. */
function run(address: string, deviceDark = false) {
  const root = fakeRoot()
  const events: string[] = []
  const window = { dispatchEvent: (event: { type: string }) => { events.push(event.type); return true } }
  let ended = address
  let writes = 0
  const store: string[] = []
  const media = { matches: deviceDark, addEventListener: () => {} }
  const history = { state: null, replaceState: (_s: unknown, _t: string, path: string) => { ended = path } }
  const location = { href: address }
  const document = { documentElement: root, cookie: '' }
  new Function('document', 'matchMedia', 'location', 'history', 'localStorage', 'sessionStorage', 'window', LOOK_SCRIPT)(
    document,
    () => media,
    location,
    history,
    { setItem: () => { writes++ }, getItem: () => null },
    { setItem: () => { writes++ }, getItem: () => null },
    window,
  )
  store.push(document.cookie)
  return { root, ended, writes, cookie: document.cookie, events }
}

describe('the head script', () => {
  it('follows the device when the link carries no look', () => {
    const { root, ended } = run('https://docs.delorun.com/guide/start?x=1', true)
    expect(root.classList.contains('dark')).toBe(true)
    expect(root.dataset['look']).toBeUndefined()
    expect(ended).toBe('https://docs.delorun.com/guide/start?x=1')
  })

  it('applies a carried look, removes its parameters and keeps the others', () => {
    const { root, ended } = run('https://docs.delorun.com/guide/start?search=a&look=ocean&scheme=dark&density=spacious#top')
    expect(root.dataset).toMatchObject({ look: 'ocean', density: 'spacious', contrast: 'default' })
    expect(root.classList.contains('dark')).toBe(true)
    expect(ended).toBe('https://docs.delorun.com/guide/start?search=a#top')
    expect(root.dataset['scheme']).toBe('dark')
  })

  it('applies a custom look with its accent and contrast', () => {
    const { root } = run('https://x.test/?look=custom&accent=moss&contrast=highest')
    expect(root.dataset).toMatchObject({ look: 'custom', accent: 'moss', contrast: 'highest' })
  })

  it('ignores a look it does not know and every value it does not know', () => {
    const { root } = run('https://x.test/?look=%3Cscript%3E&density=wide&scheme=green')
    expect(root.dataset).toMatchObject({ look: 'soft', density: 'comfortable', contrast: 'default' })
    expect(root.classList.contains('dark')).toBe(false)
  })

  it('stays out of the way on an address that cannot be rewritten, and still paints the look', () => {
    const root = fakeRoot()
    const document = { documentElement: root }
    const history = { state: null, replaceState: () => { throw new Error('SecurityError') } }
    expect(() => new Function('document', 'matchMedia', 'location', 'history', 'window', LOOK_SCRIPT)(document, () => ({ matches: false, addEventListener: () => {} }), { href: 'https://x.test//evil.example/?look=ember' }, history, { dispatchEvent: () => true })).not.toThrow()
    expect(root.dataset['look']).toBe('ember')
  })

  it('writes nothing to storage or cookies', () => {
    const result = run('https://x.test/?look=ember&scheme=light')
    expect(result.writes).toBe(0)
    expect(result.cookie).toBe('')
    expect(LOOK_SCRIPT).not.toMatch(/localStorage|sessionStorage|cookie|indexedDB/)
  })

  it('reads a link as the module does', () => {
    const query = '?look=grove&density=compact&scheme=light'
    const { root } = run(`https://x.test/${query}`)
    expect(currentLook(root as never)).toEqual({ ...parseLook(new URLSearchParams(query)), accent: 'peach' })
  })
})

describe('links that carry a look', () => {
  const ocean: Look = { ...DEFAULT_LOOK, look: 'ocean', scheme: 'dark' }

  it('writes only what differs from the default', () => {
    expect(lookQuery(DEFAULT_LOOK)).toBe('')
    expect(lookQuery(ocean)).toBe('look=ocean&scheme=dark')
  })

  it('adds the look to an absolute and a relative link and replaces an old one', () => {
    expect(withLook('https://docs.delorun.com/', ocean)).toBe('https://docs.delorun.com/?look=ocean&scheme=dark')
    expect(withLook('/guide/start?look=iris&x=1#a', ocean)).toBe('/guide/start?x=1&look=ocean&scheme=dark#a')
    expect(withLook('https://docs.delorun.com/?look=iris', DEFAULT_LOOK)).toBe('https://docs.delorun.com/')
  })

  it('parses nothing from a query without a look parameter', () => {
    expect(parseLook(new URLSearchParams('x=1'))).toBeUndefined()
  })

  it('follows the device again when the look has no scheme, and reads no scheme from a page that follows it', () => {
    const root = fakeRoot()
    applyLook(root, { ...DEFAULT_LOOK, scheme: 'dark' })
    expect(root.dataset['scheme']).toBe('dark')
    expect(currentLook(root).scheme).toBe('dark')
    applyLook(root, { ...DEFAULT_LOOK, scheme: undefined }, false)
    expect(root.dataset['scheme']).toBeUndefined()
    expect(root.classList.contains('dark')).toBe(false)
    expect(currentLook(root).scheme).toBeUndefined()
    applyLook(root, DEFAULT_LOOK, true)
    expect(root.classList.contains('dark')).toBe(true)
  })

  it('applies a look to the root and reads it back', () => {
    const root = fakeRoot()
    applyLook(root, { ...DEFAULT_LOOK, look: 'custom', accent: 'cobalt', contrast: 'high' })
    expect(root.dataset).toMatchObject({ look: 'custom', accent: 'cobalt', contrast: 'high' })
    applyLook(root, ocean)
    expect(root.dataset['accent']).toBeUndefined()
    expect(currentLook(root).look).toBe('ocean')
  })
})

describe('the sites\' security headers', () => {
  const hash = `'sha256-${createHash('sha256').update(LOOK_SCRIPT).digest('base64')}'`
  for (const site of ['website', 'docs']) {
    it(`let the ${site} run its inline head script`, () => {
      const headers = readFileSync(fileURLToPath(new URL(`../../../apps/${site}/public/_headers`, import.meta.url)), 'utf8')
      const policies = headers.split('\n').filter(line => /Content-Security-Policy/i.test(line))
      expect(policies.length).toBeGreaterThan(0)
      for (const policy of policies) {
        const restricts = /script-src|default-src/.test(policy)
        // A policy that restricts scripts must allow this script by its hash, never by 'unsafe-inline'.
        if (restricts) {
          expect(policy).toContain(hash)
          expect(policy).not.toContain("'unsafe-inline'")
        }
      }
    })
  }
})
