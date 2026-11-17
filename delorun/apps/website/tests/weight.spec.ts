import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { chunkKind, failures, LIMITS, measure } from '../scripts/weight.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

/** A built site with an entry script, one stylesheet, the two fonts and the given lazy files. */
function site(lazy: Record<string, string>, extraStart = ''): string {
  const out = mkdtempSync(join(tmpdir(), 'weight-'))
  dirs.push(out)
  mkdirSync(join(out, 'assets'))
  writeFileSync(join(out, 'index.html'), `<html><link rel="stylesheet" href="/assets/app.css"/><link rel="preload" as="font" href="/assets/schibsted-grotesk-latin-x.woff2"/><script type="module" src="/assets/index-a.js"></script>${extraStart}</html>`)
  writeFileSync(join(out, 'assets', 'app.css'), 'a{color:red}')
  writeFileSync(join(out, 'assets', 'index-a.js'), 'console.log(1)')
  writeFileSync(join(out, 'assets', 'schibsted-grotesk-latin-x.woff2'), 'font')
  for (const [name, text] of Object.entries(lazy)) writeFileSync(join(out, 'assets', name), text)
  return out
}

/** Text that does not compress, so a size in bytes is a size on the wire. */
const noise = (bytes: number): string => randomBytes(bytes + 4000).toString('base64')

describe('the weight check', () => {
  it('measures the first screen, the start script and the lazy chunks of a built site', () => {
    const weights = measure(site({ 'toast.web-b.js': 'x', 'replica-player-c.js': 'y', 'session-one-d.js': 'z' }))
    expect(weights.preloadedFonts).toBe(1)
    expect(weights.firstScreen).toBeGreaterThan(0)
    expect(weights.lazy.map(chunk => `${chunk.file}:${chunk.kind}`).sort()).toEqual(['replica-player-c.js:replica', 'session-one-d.js:session', 'toast.web-b.js:section'])
    expect(failures(weights)).toEqual([])
  })

  it('fails a start script, a section, a session and a replica over their limits, and names each', () => {
    const out = site({ 'big-section-b.js': noise(LIMITS.section + 2000), 'session-big-c.js': noise(LIMITS.session + 2000), 'replica-big-d.js': noise(LIMITS.replica + 2000) })
    writeFileSync(join(out, 'assets', 'index-a.js'), noise(LIMITS.interactiveScript + 2000))
    const messages = failures(measure(out))
    expect(messages.some(message => message.startsWith('the interactive script'))).toBe(true)
    expect(messages.some(message => message.includes('section chunk big-section-b.js'))).toBe(true)
    expect(messages.some(message => message.includes('session chunk session-big-c.js'))).toBe(true)
    expect(messages.some(message => message.includes('replica chunk replica-big-d.js'))).toBe(true)
    expect(messages.some(message => message.startsWith('the replica '))).toBe(true)
  })

  it('fails a third font preload and an over-weight first screen', () => {
    const out = site({})
    writeFileSync(join(out, 'index.html'), `<link rel="stylesheet" href="/assets/app.css"/><link rel="preload" as="font" href="a"/><link rel="preload" as="font" href="b"/><link rel="preload" as="font" href="c"/><script type="module" src="/assets/index-a.js"></script>${noise(LIMITS.firstScreen + 2000)}`)
    const messages = failures(measure(out))
    expect(messages).toContain('3 fonts are preloaded, over the limit of 2')
    expect(messages.some(message => message.startsWith('the first screen'))).toBe(true)
  })

  it('classifies chunks by name', () => {
    expect(chunkKind('replica-x.js')).toBe('replica')
    expect(chunkKind('session-a.js')).toBe('session')
    expect(chunkKind('theme-menu.js')).toBe('section')
  })

  it('refuses a site that was not built', () => {
    expect(() => measure(join(tmpdir(), 'no-such-site-out'))).toThrow(/build the site first/)
  })
})
