// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
// Test-only imports of the theme's palette generator from its source, so the spec resolves each palette's real token values.
import { DEFAULT_SETTINGS, PALETTES } from '../../plugin-theme/src/config.ts'
import { contrast, fromOklch, over, toOklch, type Rgb } from '../../plugin-theme/src/palette/color.ts'
import { applyLayers, requireResolved, type SchemeValues } from '../../plugin-theme/src/palette/generate.ts'
import { themeLayers } from '../../plugin-theme/src/palette/layers.ts'
import { STOCK_TOKENS } from '../../plugin-theme/src/palette/stock.ts'
import { HeaderArt } from '../src/client/HeaderArt.tsx'
import { StageBackdrop, TITLE_VEIL_FILL, TITLE_VEIL_TOKEN, titleVeilColor, type TitleVeilPart } from '../src/client/StageArt.tsx'
import { ART_STYLES, DEFAULT_SIDEBAR_SETTINGS, HEADER_ARTS, type SidebarSettings } from '../src/config.ts'

afterEach(cleanup)

/** The title's and the toggle's colours, and the sidebar's fill they sit on when no art lies under them. */
const TITLE = '--dsw-alias-label-primary'
const TOGGLE = '--dsw-alias-label-secondary'
const SIDEBAR_FILL = '--dsw-specific-sidebar-fill'

const SCHEMES = ['light', 'dark'] as const

/**
 * A stylesheet's text, read from disk: Vitest serves stylesheets to specs as empty modules.
 * @param name - the stylesheet's file name under `src/client/`.
 * @returns its text.
 */
const stylesheet = (name: string): string => readFileSync(resolve(import.meta.dirname, '../src/client', name), 'utf8')

type Scheme = typeof SCHEMES[number]

const settingsOf = (fields: Partial<SidebarSettings>) => <R,>(select: (value: SidebarSettings) => R): R => select({ ...DEFAULT_SIDEBAR_SETTINGS, ...fields })

const themeValues = (palette: typeof PALETTES[number], scheme: Scheme): SchemeValues => {
  const layers = themeLayers({ ...DEFAULT_SETTINGS, studioAdditions: true, palette })
  return applyLayers(STOCK_TOKENS, [layers.palette ?? {}, layers.accent ?? {}], scheme)
}

const OKLCH = /oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/
const oklch = (value: string): Rgb => {
  const match = OKLCH.exec(value)
  if (match === null) throw new Error(`not an oklch() colour: ${value}`)
  return fromOklch({ l: Number(match[1]), c: Number(match[2]), h: Number(match[3]), alpha: 1 })
}

/** Every named art colour in `art-palettes.css`, by scheme: the superset of what any scene in any art palette draws with. */
function namedArtColours(): Record<Scheme, Map<string, Rgb>> {
  const text = stylesheet('art-palettes.css')
  const found = { light: new Map<string, Rgb>(), dark: new Map<string, Rgb>() }
  for (const [, name = '', value = ''] of text.matchAll(/(--delo-art-[\w-]+):\s*([^;]+);/g)) {
    const pair = /light-dark\((oklch\([^)]*\)),\s*(oklch\([^)]*\))\)/.exec(value)
    found.light.set(name, oklch(pair?.[1] ?? value))
    found.dark.set(name, oklch(pair?.[2] ?? value))
  }
  return found
}

/** The accent palette's mixes of the studio's accent with its named anchors, read from `StageArt.module.css`. */
function accentMixes(): Array<{ readonly share: number; readonly anchor: string }> {
  const text = stylesheet('StageArt.module.css')
  return [...text.matchAll(/color-mix\(in oklch, var\(--dsw-alias-brand-primary\) (\d+)%, var\((--delo-art-accent-[\w-]+)\)\)/g)]
    .map(([, share = '0', anchor = '']) => ({ share: Number(share) / 100, anchor }))
}

/** `color-mix(in oklch, a share, b)`, hue along the shorter arc. */
function mixOklch(a: Rgb, share: number, b: Rgb): Rgb {
  const [first, second] = [toOklch(a), toOklch(b)]
  const turn = ((second.h - first.h + 540) % 360) - 180
  return fromOklch({ l: first.l * share + second.l * (1 - share), c: first.c * share + second.c * (1 - share), h: first.h - turn * (1 - share), alpha: 1 })
}

const clamp = (value: number): number => Math.min(1, Math.max(0, value))

/** The vivid strength's `saturate(1.45) contrast(1.12)`, applied in sRGB as the browser's filter functions are. */
function vivid({ r, g, b }: Rgb): Rgb {
  const s = 1.45
  const saturated = {
    r: (0.213 + 0.787 * s) * r + (0.715 - 0.715 * s) * g + (0.072 - 0.072 * s) * b,
    g: (0.213 - 0.213 * s) * r + (0.715 + 0.285 * s) * g + (0.072 - 0.072 * s) * b,
    b: (0.213 - 0.213 * s) * r + (0.715 - 0.715 * s) * g + (0.072 + 0.928 * s) * b,
  }
  const contrasted = (channel: number): number => clamp((clamp(channel) - 0.5) * 1.12 + 0.5)
  return { r: contrasted(saturated.r), g: contrasted(saturated.g), b: contrasted(saturated.b), alpha: 1 }
}

/**
 * Every colour that can lie under the title in a theme palette and scheme: each named art colour and each accent mix,
 * drawn at every strength (subtle at 55% over the sidebar, standard as drawn, vivid filtered).
 * @param values - the theme's resolved tokens.
 * @param scheme - the colour scheme.
 * @returns the colours, opaque.
 */
function artColours(values: SchemeValues, scheme: Scheme): Rgb[] {
  const named = namedArtColours()[scheme]
  const accent = requireResolved(values, '--dsw-alias-brand-primary')
  const drawn = [...named.values(), ...accentMixes().map(({ share, anchor }) => mixOklch(accent, share, named.get(anchor) ?? accent))]
  const fill = requireResolved(values, SIDEBAR_FILL)
  return drawn.flatMap(colour => [over({ ...colour, alpha: 0.55 }, fill), colour, vivid(colour)])
}

/**
 * One part of the veil over a colour, at the share `TITLE_VEIL_FILL` gives that part in the scheme.
 * @param values - the theme's resolved tokens.
 * @param scheme - the colour scheme.
 * @param part - the title or the toggle.
 * @param art - the colour under the veil.
 * @returns the colour the ink sits on.
 */
const veiled = (values: SchemeValues, scheme: Scheme, part: TitleVeilPart, art: Rgb): Rgb => {
  const fill = requireResolved(values, TITLE_VEIL_TOKEN)
  return over({ ...fill, alpha: fill.alpha * TITLE_VEIL_FILL[scheme][part] / 100 }, art)
}

describe('the sidebar title over the header art', () => {
  for (const palette of PALETTES) {
    for (const scheme of SCHEMES) {
      it(`reads at 4.5:1 or more, with the toggle at 3:1, on the veil over every art colour, in ${palette} (${scheme})`, () => {
        const values = themeValues(palette, scheme)
        const [title, toggle] = [requireResolved(values, TITLE), requireResolved(values, TOGGLE)]
        const colours = artColours(values, scheme)
        expect(colours.length).toBeGreaterThan(100)
        const worst = (ink: Rgb, part: TitleVeilPart): number => Math.min(...colours.map(art => contrast(ink, veiled(values, scheme, part, art))))
        expect(worst(title, 'title'), `${TITLE} on the title's share of the veil`).toBeGreaterThanOrEqual(4.5)
        expect(worst(toggle, 'toggle'), `${TOGGLE} on the toggle's share of the veil`).toBeGreaterThanOrEqual(3)
      })
    }
  }

  it('fails without the veil, or with the title\'s share under the toggle, so the check reaches colours that need each share', () => {
    const values = themeValues(PALETTES[0], 'light')
    const [title, toggle] = [requireResolved(values, TITLE), requireResolved(values, TOGGLE)]
    const colours = artColours(values, 'light')
    expect(Math.min(...colours.map(art => contrast(title, art)))).toBeLessThan(4.5)
    expect(Math.min(...colours.map(art => contrast(toggle, veiled(values, 'light', 'title', art))))).toBeLessThan(3)
  })

  it('draws the veil, in the sidebar\'s fill and marked plain so the title keeps its colours, under every art behind the sidebar\'s top', () => {
    for (const headerArt of HEADER_ARTS.filter(art => art !== 'none')) {
      const { container } = render(<HeaderArt useSettings={settingsOf({ headerArt, artStyle: 'artwork' })} />)
      const veil = container.querySelector<HTMLElement>('[data-title-veil]')
      expect(veil, headerArt).not.toBeNull()
      expect(veil?.hasAttribute('data-backdrop-plain')).toBe(true)
      expect(veil?.style.getPropertyValue('--title-veil')).toBe(titleVeilColor('title'))
      expect(veil?.style.getPropertyValue('--title-veil-toggle')).toBe(titleVeilColor('toggle'))
      cleanup()
    }
    for (const part of ['title', 'toggle'] as const) {
      expect(titleVeilColor(part)).toBe(`light-dark(${[TITLE_VEIL_FILL.light[part], TITLE_VEIL_FILL.dark[part]]
        .map(share => `color-mix(in srgb, var(${TITLE_VEIL_TOKEN}, var(--dsw-alias-bg-base)) ${String(share)}%, transparent)`).join(', ')})`)
    }
  })

  it('draws no veil for no art or for the pill beside the name, where the title sits on the sidebar', () => {
    for (const artStyle of ART_STYLES) {
      const none = render(<HeaderArt useSettings={settingsOf({ headerArt: 'none', artStyle })} />)
      expect(none.container.childElementCount).toBe(0)
      cleanup()
    }
    const pill = render(<HeaderArt useSettings={settingsOf({ artStyle: 'pill' })} />)
    expect(pill.container.querySelector('[data-title-veil]')).toBeNull()
    expect(pill.container.querySelector('[data-backdrop-plain]')).not.toBeNull()
  })

  it('finds no veil in the art alone', () => {
    const { container } = render(<StageBackdrop scene="blueprint" palette="accent" />)
    expect(container.querySelector('[data-title-veil]')).toBeNull()
  })

  it('keeps the title at 4.5:1 on the sidebar itself, where no art or the pill leaves it, in every palette', () => {
    for (const palette of PALETTES) {
      for (const scheme of SCHEMES) {
        const values = themeValues(palette, scheme)
        expect(contrast(requireResolved(values, TITLE), requireResolved(values, SIDEBAR_FILL)), `${palette} ${scheme}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('keeps the secondary label, which the row\'s small text uses, at 4.5:1 on the surfaces of the list in every palette', () => {
    for (const palette of PALETTES) {
      for (const scheme of SCHEMES) {
        const values = themeValues(palette, scheme)
        for (const surface of [SIDEBAR_FILL, '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1']) {
          const ratio = contrast(requireResolved(values, TOGGLE), requireResolved(values, surface))
          expect(ratio, `${palette} ${scheme} on ${surface}`).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })
})
