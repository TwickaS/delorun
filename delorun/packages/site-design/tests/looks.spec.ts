import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PALETTES, PRESET_PALETTES } from '../../plugin-theme/src/config.ts'
import { en } from '../../plugin-theme/src/client/locales.ts'
import { ACCENT_IDS } from '../../plugin-theme/src/palette/soft.ts'
import { buildLooks, buildSwatches, CONTRAST_STOPS, LOOKS, ratio, resolveLook, ROLES, selector, type RoleName } from '../scripts/looks.ts'
import { KNOWN_LOOKS, LOOK_NAMES, lookName } from '../src/looks.ts'

const STYLESHEET = fileURLToPath(new URL('../src/looks.css', import.meta.url))

describe('the looks stylesheet', () => {
  it('is the one the Theme plugin generates now', () => {
    expect(readFileSync(STYLESHEET, 'utf8')).toBe(buildLooks())
  })

  it('has swatches equal to the ones the Theme plugin generates now', () => {
    expect(readFileSync(fileURLToPath(new URL('../src/look-swatches.ts', import.meta.url)), 'utf8')).toBe(buildSwatches())
  })

  it('keeps the T3 Code copyright comment', () => {
    expect(buildLooks()).toMatch(/T3 Code \(MIT licence\), commit [0-9a-f]{40}\.\n \* Copyright \(c\) \d{4} T3 Tools Inc\./)
  })

  it('has a rule for every preset palette and every custom accent preset', () => {
    const css = buildLooks()
    for (const palette of PRESET_PALETTES) expect(css).toContain(`${selector({ palette })} {`)
    for (const accent of ACCENT_IDS) expect(css).toContain(`${selector({ palette: 'custom', accent })} {`)
    expect(LOOKS).toHaveLength(PRESET_PALETTES.length + ACCENT_IDS.length)
  })
})

describe('the looks the sites offer', () => {
  it('lists the studio palettes in the studio order, by the studio ids', () => {
    expect(KNOWN_LOOKS).toEqual(PALETTES)
  })

  it('names each look as the studio names its tile', () => {
    for (const id of PALETTES) expect(LOOK_NAMES[id]).toBe(en[`palette.${id}` as keyof typeof en])
    expect(lookName('t3-code')).toBe('Slate')
    expect(lookName('t3-chat')).toBe('Berry')
  })
})

describe('text contrast in every look', () => {
  const pairs: ReadonlyArray<readonly [RoleName, RoleName]> = [
    ['text', 'surface'], ['text', 'raised'], ['text', 'sunken'],
    ['muted', 'surface'], ['muted', 'raised'], ['muted', 'sunken'],
    ['accent-text', 'surface'], ['accent-text', 'raised'], ['accent-text', 'sunken'],
    ['on-accent', 'accent'],
  ]
  for (const look of LOOKS) {
    for (const scheme of ['light', 'dark'] as const) {
      it(`reaches AA in ${selector(look)} ${scheme}`, () => {
        const colours = resolveLook(look, scheme)
        for (const [foreground, background] of pairs) {
          expect(ratio(colours, foreground, background), `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5)
        }
      })
    }
  }

  it('offers only contrast stops that move quiet text towards the text colour, since the palettes put quiet text at the AA floor', () => {
    for (const value of Object.values(CONTRAST_STOPS)) expect(value).toBeGreaterThan(0)
  })

  it('resolves every role', () => {
    expect(Object.keys(ROLES)).toHaveLength(13)
  })
})
