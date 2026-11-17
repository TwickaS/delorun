/** The web entry page lets a phone draw under its notch and colours the browser chrome per scheme. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const html = await readFile(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8')

describe('web index.html', () => {
  it('declares viewport-fit=cover so safe-area insets apply', () => {
    expect(html).toMatch(/<meta name="viewport" content="[^"]*viewport-fit=cover[^"]*"/)
  })

  it('gives one theme-color for each colour scheme', () => {
    expect(html.match(/<meta name="theme-color" content="#[0-9a-f]{6}" media="\(prefers-color-scheme: light\)"/g)).toHaveLength(1)
    expect(html.match(/<meta name="theme-color" content="#[0-9a-f]{6}" media="\(prefers-color-scheme: dark\)"/g)).toHaveLength(1)
  })
})
