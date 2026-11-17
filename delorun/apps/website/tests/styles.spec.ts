import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { linkChunkStyles, unstyledClasses } from '../scripts/styles.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

/** A built site with one page that uses the given classes and links the given stylesheets. */
function site(classes: string, sheets: Record<string, string>, linked: string[]): string {
  const out = mkdtempSync(join(tmpdir(), 'styles-'))
  dirs.push(out)
  mkdirSync(join(out, 'assets'))
  for (const [name, text] of Object.entries(sheets)) writeFileSync(join(out, 'assets', name), text)
  writeFileSync(join(out, 'index.html'), `<html><head>${linked.map(name => `<link rel="stylesheet" href="/assets/${name}"/>`).join('')}</head><body><div class="${classes}"></div></body></html>`)
  return out
}

describe('the styles of a prerendered page', () => {
  it('passes when every class has a rule in a linked stylesheet, escaped utility names included', () => {
    const out = site('flex sm:px-6 w-[min(22rem,100vw)] stillBox_a1', { 'app.css': '.flex{display:flex}.sm\\:px-6{padding:1px}.w-\\[min\\(22rem\\,100vw\\)\\]{width:1px}.stillBox_a1{height:1px}' }, ['app.css'])
    expect(unstyledClasses(out, 'index.html')).toEqual([])
  })

  it('counts the rules in a style block the page carries', () => {
    const out = site('flex inlineOnly_a1', { 'app.css': '.flex{}' }, ['app.css'])
    writeFileSync(join(out, 'index.html'), readFileSync(join(out, 'index.html'), 'utf8').replace('</head>', '<style>.inlineOnly_a1{color:red}</style></head>'))
    expect(unstyledClasses(out, 'index.html')).toEqual([])
  })

  it('skips a class that only scopes rules loaded later, and still names every other', () => {
    const out = site('flex scopeOnly other_a1', { 'app.css': '.flex{}' }, ['app.css'])
    expect(unstyledClasses(out, 'index.html', ['scopeOnly'])).toEqual(['other_a1'])
  })

  it('names a class whose rule is only in a stylesheet the page does not link', () => {
    const out = site('flex stillBox_a1', { 'app.css': '.flex{}', 'home-below-x.css': '.stillBox_a1{height:1px}' }, ['app.css'])
    expect(unstyledClasses(out, 'index.html')).toEqual(['stillBox_a1'])
  })

  it('links a chunk\'s stylesheet from the page, once, and the class is then styled', () => {
    const out = site('flex stillBox_a1', { 'app.css': '.flex{}', 'home-below-x.css': '.stillBox_a1{height:1px}' }, ['app.css'])
    linkChunkStyles(out, { 'index.html': ['home-below'] })
    linkChunkStyles(out, { 'index.html': ['home-below'] })
    expect(unstyledClasses(out, 'index.html')).toEqual([])
    expect(readFileSync(join(out, 'index.html'), 'utf8').match(/home-below-x\.css/g)).toHaveLength(1)
  })

  it('fails loud when a named chunk has no stylesheet, so a renamed chunk is noticed', () => {
    const out = site('flex', { 'app.css': '.flex{}' }, ['app.css'])
    expect(() => linkChunkStyles(out, { 'index.html': ['home-below'] })).toThrow(/no stylesheet for the chunk "home-below"/)
  })
})
