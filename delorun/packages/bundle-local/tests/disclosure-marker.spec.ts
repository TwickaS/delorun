/** The consent boxes' disclosures draw the studio's chevron instead of the browser's triangle. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/ConsentSections.module.css', import.meta.url)), 'utf8')

describe('consent disclosures', () => {
  it.each(['others', 'disclosure'])('hides the browser marker of .%s and draws a chevron that turns when open', (name) => {
    expect(css).toMatch(new RegExp(`\\.${name} > summary[,\\s][^{]*\\{[^}]*list-style: none;`))
    expect(css).toContain(`.${name} > summary::-webkit-details-marker`)
    expect(css).toContain(`.${name}[open] > summary::before`)
  })
})
