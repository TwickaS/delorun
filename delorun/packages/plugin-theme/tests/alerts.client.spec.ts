/**
 * The alert sheet (`src/client/alerts.css`): it styles every class `@delorun/brand`'s `Alert` names, falls back to an
 * opaque surface without blur or under reduced transparency, moves nothing under reduced motion and animates only
 * `transform` and `opacity`; and the title, the muted line and the tinted action reach WCAG AA on the glass in every
 * preset palette and both schemes, over a page covered by dense text under the blur.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ALERT_CLASSES } from '@delorun/brand/alert'
import { contrast, over, type Rgb } from '../src/palette/color.ts'
import { applyLayers, requireResolved } from '../src/palette/generate.ts'
import { themeLayers } from '../src/palette/layers.ts'
import { STOCK_TOKENS } from '../src/palette/stock.ts'
import { DEFAULT_SETTINGS, PRESET_PALETTES } from '../src/config.ts'

const SHEET = readFileSync(fileURLToPath(new URL('../src/client/alerts.css', import.meta.url)), 'utf8')

/**
 * The text of the block that follows a prelude, braces balanced.
 * @param prelude - the at-rule or selector text the block starts after.
 * @returns the block's contents.
 */
function block(prelude: string): string {
  const start = SHEET.indexOf(prelude)
  if (start < 0) throw new Error(`no block ${prelude}`)
  const open = SHEET.indexOf('{', start)
  let depth = 0
  for (let index = open; index < SHEET.length; index++) {
    if (SHEET[index] === '{') depth++
    if (SHEET[index] === '}' && --depth === 0) return SHEET.slice(open + 1, index)
  }
  throw new Error(`unbalanced block ${prelude}`)
}

/**
 * The number in a `--name: <n>%` declaration of the sheet's first `body` block.
 * @param name - the custom property.
 * @returns the percentage as a fraction.
 */
function percent(name: string, scope = block('body {')): number {
  const match = new RegExp(`${name}:[^;]*?(\\d+)%`).exec(scope)
  if (match?.[1] === undefined) throw new Error(`${name} has no percentage`)
  return Number(match[1]) / 100
}

describe('the alert sheet', () => {
  it('styles every class the Alert component names', () => {
    for (const name of Object.values(ALERT_CLASSES)) expect(SHEET).toContain(`.${name}`)
  })

  it('makes the surface opaque without backdrop blur, under reduced transparency and under more contrast', () => {
    expect(block('@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))')).toContain('--delorun-glass-fill: var(--delorun-glass-fill-solid)')
    for (const query of ['@media (prefers-reduced-transparency: reduce)', '@media (prefers-contrast: more)']) {
      const rules = block(query)
      expect(rules).toContain('--delorun-glass-fill: var(--delorun-glass-fill-solid)')
      expect(rules).toContain('--delorun-glass-blur: none')
    }
  })

  it('declares the fill and blur only on body, so the dark scheme cannot outrank a fallback', () => {
    expect(block('body[data-ds-dark-theme] {')).not.toMatch(/--delorun-glass-(fill|blur)/)
  })

  it('moves only under no-preference, and only transform and opacity, so nothing moves under reduced motion', () => {
    const outside = SHEET.replace(block('@media (prefers-reduced-motion: no-preference)'), '')
    expect(outside).not.toMatch(/\btransition\s*:/)
    expect(outside).not.toContain('@starting-style')
    const transitions = [...block('@media (prefers-reduced-motion: no-preference)').matchAll(/transition:\s*([^;]+);/g)].map(match => match[1] ?? '')
    expect(transitions.length).toBeGreaterThan(0)
    for (const value of transitions) {
      for (const part of value.split(',')) expect(part.trim().split(/\s+/)[0]).toMatch(/^(opacity|transform|background-color)$/)
    }
    const reduced = block('@media (prefers-reduced-motion: reduce)')
    expect(reduced).toContain('animation: none')
    expect(reduced).not.toContain('transform')
  })

  it('mixes the action text in sRGB, as the contrast check below computes it', () => {
    expect(block('body {')).toMatch(/--delorun-alert-action: color-mix\(in srgb, var\(--dsw-alias-link\) \d+%, var\(--dsw-alias-label-primary\)\)/)
  })

  it('enters in about 200 ms and leaves faster, about 150 ms', () => {
    expect(block('body {')).toMatch(/--delorun-alert-enter: 200ms/)
    expect(block('body {')).toMatch(/--delorun-alert-exit: 150ms/)
    expect(block('body {')).toMatch(/--delorun-alert-slide: 8px/)
  })
})

describe('the glass text contrast', () => {
  const fill = percent('--delorun-glass-fill')
  const tint = { light: percent('--delorun-alert-button-tint'), dark: percent('--delorun-alert-button-tint', block('body[data-ds-dark-theme] {')) }
  const action = percent('--delorun-alert-action')
  const withAlpha = (color: Rgb, alpha: number): Rgb => ({ ...color, alpha })
  /** CSS `color-mix(in srgb, a <weight>, b)`: a straight mix of the gamma-encoded channels. */
  const srgbMix = (a: Rgb, b: Rgb, weight: number): Rgb => ({ r: a.r * weight + b.r * (1 - weight), g: a.g * weight + b.g * (1 - weight), b: a.b * weight + b.b * (1 - weight), alpha: 1 })

  for (const palette of PRESET_PALETTES) {
    for (const scheme of ['light', 'dark'] as const) {
      it(`reaches AA for the title, the line and the tinted action in ${palette}, ${scheme}`, () => {
        const layers = themeLayers({ ...DEFAULT_SETTINGS, studioAdditions: true, palette })
        const values = applyLayers(STOCK_TOKENS, [layers.palette, layers.accent].filter(layer => layer !== undefined), scheme)
        const colour = (name: string): Rgb => requireResolved(values, name)
        // What the blur leaves of a page covered in dense text: about a quarter of a 14 px line's box is ink, so 35% ink
        // over the page is beyond any chat transcript the toast floats over.
        const backdrop = over(withAlpha(colour('--dsw-alias-label-primary'), 0.35), colour('--dsw-alias-bg-base'))
        const glass = over(withAlpha(colour('--dsw-alias-bg-layer-1'), fill), backdrop)
        expect(contrast(colour('--dsw-alias-label-primary'), glass)).toBeGreaterThanOrEqual(4.5)
        expect(contrast(colour('--dsw-alias-label-secondary'), glass)).toBeGreaterThanOrEqual(4.5)
        const button = over(withAlpha(colour('--dsw-alias-link'), tint[scheme]), glass)
        expect(contrast(srgbMix(colour('--dsw-alias-link'), colour('--dsw-alias-label-primary'), action), button)).toBeGreaterThanOrEqual(4.5)
      })
    }
  }
})
