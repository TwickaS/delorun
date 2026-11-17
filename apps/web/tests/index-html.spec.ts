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
})
