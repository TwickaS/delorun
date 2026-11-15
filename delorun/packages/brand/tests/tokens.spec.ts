/** The brand values agree across `tokens.ts`, `tokens.css`, the mark's static files and the studio's default accent. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BRAND_COLOURS, BRAND_FONTS, BRAND_RADII } from '../src/tokens.ts'
import { MARK } from '../src/mark.tsx'

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')

/** The WCAG relative luminance of a six-digit hex colour. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
    .map(value => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0)
}

/** The WCAG contrast ratio of two hex colours. */
function ratio(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05)
}

describe('the brand colours', () => {
  it('put the text-safe peach at WCAG AA (4.5:1) on white and on the light page, and text on peach likewise', () => {
    expect(ratio(BRAND_COLOURS.peachText, '#FFFFFF')).toBeGreaterThanOrEqual(4.5)
    expect(ratio(BRAND_COLOURS.peachText, '#FCFCFC')).toBeGreaterThanOrEqual(4.5)
    expect(ratio(BRAND_COLOURS.peach, '#111110')).toBeGreaterThanOrEqual(4.5)
    expect(ratio(BRAND_COLOURS.onPeach, BRAND_COLOURS.peach)).toBeGreaterThanOrEqual(4.5)
  })

  it('are the values tokens.css declares', () => {
    const css = read('../src/tokens.css')
    expect(css).toContain(`--dl-peach: ${BRAND_COLOURS.peach};`)
    expect(css).toContain(`light-dark(${BRAND_COLOURS.peachText}, ${BRAND_COLOURS.peach})`)
    expect(css).toContain(`--dl-on-accent: ${BRAND_COLOURS.onPeach};`)
    for (const [name, px] of Object.entries(BRAND_RADII)) expect(css).toContain(`var(--dsw-radius-${name}, ${px}px)`)
    expect(css).toContain(BRAND_FONTS.sans.split(',')[0])
  })

  // The studio theme sets --dsw-font-family to the system stack, so a brand face that comes after it is never reached.
  it('lead with the brand typefaces, before the studio theme stack', () => {
    const css = read('../src/tokens.css')
    expect(css).toContain(`--dl-font-sans: ${BRAND_FONTS.sans.split(',')[0]}, var(--dsw-font-family,`)
    expect(css).toContain(`--dl-font-mono: ${BRAND_FONTS.mono.split(',')[0]}, var(--dsw-font-mono,`)
  })

  it('are the studio theme plugin default accent', () => {
    expect(read('../../plugin-theme/src/config.ts')).toContain(`DEFAULT_CUSTOM_ACCENT = '${BRAND_COLOURS.peach}'`)
  })
})

describe('the mark', () => {
  it('is the drawing in both favicons', () => {
    for (const file of ['../../../apps/website/public/favicon.svg', '../../../apps/docs/public/favicon.svg']) {
      const svg = read(file)
      expect(svg).toContain(`d="${MARK.nut}"`)
      expect(svg).toContain(`r="${MARK.plug.r}"`)
      expect(svg.toLowerCase()).toContain(BRAND_COLOURS.peach.toLowerCase())
    }
  })
})

describe('the package manifest', () => {
  it('declares no sideEffects, because the studio bundler then drops the tokens.css import and the components lose every --dl-* value', () => {
    expect(JSON.parse(read('../package.json'))).not.toHaveProperty('sideEffects')
  })
})
