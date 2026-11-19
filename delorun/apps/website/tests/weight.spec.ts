import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { failures, LIMITS, measure, pictureBytes } from '../scripts/weight.ts'

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
    const weights = measure(site({ 'toast.web-b.js': 'x', 'theme-menu-c.js': 'y' }))
    expect(weights.preloadedFonts).toBe(1)
    expect(weights.firstScreen).toBeGreaterThan(0)
    expect(weights.lazy.map(chunk => `${chunk.file}:${chunk.kind}`).sort()).toEqual(['theme-menu-c.js:section', 'toast.web-b.js:section'])
    expect(failures(weights)).toEqual([])
  })

  it('fails a start script and a section over their limits, and names each', () => {
    const out = site({ 'big-section-b.js': noise(LIMITS.section + 2000) })
    writeFileSync(join(out, 'assets', 'index-a.js'), noise(LIMITS.interactiveScript + 2000))
    const messages = failures(measure(out))
    expect(messages.some(message => message.startsWith('the interactive script'))).toBe(true)
    expect(messages.some(message => message.includes('section chunk big-section-b.js'))).toBe(true)
  })

  it('fails a third font preload and an over-weight first screen', () => {
    const out = site({})
    writeFileSync(join(out, 'index.html'), `<link rel="stylesheet" href="/assets/app.css"/><link rel="preload" as="font" href="a"/><link rel="preload" as="font" href="b"/><link rel="preload" as="font" href="c"/><script type="module" src="/assets/index-a.js"></script>${noise(LIMITS.firstScreen + 2000)}`)
    const messages = failures(measure(out))
    expect(messages).toContain('3 fonts are preloaded, over the limit of 2')
    expect(messages.some(message => message.startsWith('the first screen'))).toBe(true)
  })

  it('holds the first screen at 155 KB, the whole prerendered HTML with its styles and fonts, and the entry script at 195 KB', () => {
    expect(LIMITS.firstScreen).toBe(155_000)
    expect(LIMITS.interactiveScript).toBe(195_000)
  })

  it('reports the picture files and those the home page names, without limiting them', () => {
    const out = site({})
    mkdirSync(join(out, 'lod'))
    writeFileSync(join(out, 'lod', 'atlas-wide-soft-dark.aaaaaaaaaa.avif'), 'x'.repeat(1000))
    writeFileSync(join(out, 'lod', 'atlas-wide-soft-dark.aaaaaaaaaa.webp'), 'x'.repeat(3000))
    writeFileSync(join(out, 'lod', 'chat.2.bbbbbbbbbb.avif'), 'x'.repeat(500))
    writeFileSync(join(out, 'index.html'), '<div style="background-image:url(/lod/atlas-wide-soft-dark.aaaaaaaaaa.avif)"></div>')
    expect(pictureBytes(out)).toEqual({ total: 4500, named: 1000, files: 3 })
    expect(failures(measure(out))).toEqual([])
    expect(pictureBytes(join(tmpdir(), 'no-such-site-out'))).toEqual({ total: 0, named: 0, files: 0 })
  })

  it('refuses a site that was not built', () => {
    expect(() => measure(join(tmpdir(), 'no-such-site-out'))).toThrow(/build the site first/)
  })
})
