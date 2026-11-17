/** The brand values agree across `tokens.ts`, `tokens.css`, the mark's static files and the studio's default accent. */
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BRAND_COLOURS, BRAND_FONTS, BRAND_MOTION, BRAND_RADII, BRAND_SURFACE } from '../src/tokens.ts'
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
    expect(css).toContain(`--dl-surface: var(--dsw-alias-bg-base, light-dark(${BRAND_SURFACE.light}, ${BRAND_SURFACE.dark}))`)
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

describe('the motion tokens', () => {
  const css = read('../src/tokens.css')
  const [base = '', reduced = ''] = css.split('@media (prefers-reduced-motion: reduce)')

  it('are the values tokens.ts declares', () => {
    expect(base).toContain(`--dl-ease-out: ${BRAND_MOTION.easing.out};`)
    expect(base).toContain(`--dl-ease-in-out: ${BRAND_MOTION.easing.inOut};`)
    expect(base).toContain(`--dl-ease: ${BRAND_MOTION.easing.plain};`)
    for (const [name, ms] of Object.entries(BRAND_MOTION.durations)) {
      expect(base).toContain(`--dl-duration-${name}: ${ms}ms;`)
      expect(base).toContain(`--dl-motion-${name}: var(--dl-duration-${name});`)
    }
    expect(base).toContain(`--dl-scale-pressed: ${BRAND_MOTION.scale.pressed};`)
    expect(base).toContain(`--dl-scale-enter: ${BRAND_MOTION.scale.enter};`)
  })

  it('have no ease-in, keep the interface within 300 ms and leave quicker than anything arrives', () => {
    expect(css).not.toMatch(/ease-in[;\s)]/)
    const { leave, explain, ...arrivals } = BRAND_MOTION.durations
    for (const ms of Object.values(arrivals)) {
      expect(ms).toBeLessThanOrEqual(300)
      expect(leave).toBeLessThan(ms)
    }
    expect(explain).toBeLessThanOrEqual(400)
  })

  it('under reduced motion stop movement and pressed shrinking but keep colour and opacity timings', () => {
    for (const name of Object.keys(BRAND_MOTION.durations)) {
      expect(reduced).toContain(`--dl-motion-${name}: 0ms;`)
      expect(reduced).not.toContain(`--dl-duration-${name}`)
    }
    expect(reduced).toContain('--dl-scale-pressed: 1;')
    expect(reduced).toContain('--dl-scale-enter: 1;')
  })

  it('are the only easing curves and durations in the library\'s stylesheets', () => {
    const files = readdirSync(new URL('../src', import.meta.url), { recursive: true, encoding: 'utf8' })
      .filter(file => file.endsWith('.css') && file !== 'tokens.css')
    expect(files.length).toBeGreaterThan(10)
    for (const file of files) {
      const text = read(`../src/${file}`).replace(/\/\*[\s\S]*?\*\//g, '').replace(/var\(--[\w-]+\)/g, '')
      const raw = text.split('\n').filter(line => /(?:transition|animation)[\w-]*\s*:/.test(line) && /\b\d+(?:\.\d+)?m?s\b|cubic-bezier|\bease(?:-in|-out|-in-out)?\b|\blinear\b/.test(line))
      expect(raw, file).toEqual([])
    }
  })
})

describe('the package manifest', () => {
  it('declares no sideEffects, because the studio bundler then drops the tokens.css import and the components lose every --dl-* value', () => {
    expect(JSON.parse(read('../package.json'))).not.toHaveProperty('sideEffects')
  })
})
