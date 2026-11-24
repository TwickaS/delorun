/** The web entry page lets a phone draw under its notch; the theme presenter colours the browser chrome. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const html = await readFile(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8')

describe('web index.html', () => {
  it('declares viewport-fit=cover so safe-area insets apply', () => {
    expect(html).toMatch(/<meta name="viewport" content="[^"]*viewport-fit=cover[^"]*"/)
  })

  it('has no static theme-color, because the theme presenter owns the one node', () => {
    expect(html).not.toMatch(/<meta name="theme-color"/)
  })

  it('installs as a standalone app that draws under the status bar', () => {
    expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />')
    expect(html).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />')
  })

  it('names the product Delorun, in the tab and on the home screen', () => {
    expect(html).toContain('<title>Delorun</title>')
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Delorun" />')
  })
})
