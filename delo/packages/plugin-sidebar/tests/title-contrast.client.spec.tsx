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
import { INK_EDGE_IDS, INK_EDGE_OPACITY, INK_EDGE_RADIUS, INK_EDGE_TOKEN, InkEdgeFilters, StageBackdrop, type InkEdgePart } from '../src/client/StageArt.tsx'
import { ART_STYLES, DEFAULT_SIDEBAR_SETTINGS, HEADER_ARTS, type SidebarSettings } from '../src/config.ts'

afterEach(cleanup)

/** The title's and the toggle's colours on the sidebar, and the sidebar's fill they sit on when no art lies under them. */
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

/** Upstream's sidebar stylesheet, which turns the brand row light over art and draws it through the edge's filters. */
const SIDEBAR_ROOT = readFileSync(resolve(import.meta.dirname, '../../../../packages/client/ui-sidebar/src/client/SidebarRoot.module.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')

/** The body of upstream's rule that turns the brand row light over art. */
const LIGHT_RULE = /\.logoRow,\s*[^{}]*\.topStrip\s*\{([^{}]*)\}/.exec(SIDEBAR_ROOT)?.[1] ?? ''

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
 * The white ink upstream's sidebar gives the brand row over art, read from its rule: the title, the mark and the toggle
 * in one static token, opaque.
 * @param values - the theme's resolved tokens.
 * @returns the title's and the toggle's ink.
 */
function lightInk(values: SchemeValues): Record<InkEdgePart, Rgb> {
  const title = /--dsw-alias-label-primary:\s*var\((--[\w-]+)\)/.exec(LIGHT_RULE)
  const toggle = /--dsw-alias-label-secondary:\s*var\((--[\w-]+)\)/.exec(LIGHT_RULE)
  if (title?.[1] === undefined || toggle?.[1] === undefined) throw new Error('upstream\'s light brand row rule changed')
  return { brand: requireResolved(values, title[1]), control: requireResolved(values, toggle[1]) }
}

/**
 * The edge around a part's ink, composited over a colour. The filter fills the ink's grown shape, whose opacity is the
 * ink's own, so the edge's opacity is the part's share times the ink's opacity.
 * @param values - the theme's resolved tokens.
 * @param share - the edge's opacity for fully opaque ink, in percent.
 * @param ink - the part's ink.
 * @param art - the colour under the edge.
 * @returns the colour the ink's outline meets, and the ink sits on.
 */
const edged = (values: SchemeValues, share: number, ink: Rgb, art: Rgb): Rgb => {
  const edge = requireResolved(values, INK_EDGE_TOKEN)
  return over({ ...edge, alpha: edge.alpha * ink.alpha * share / 100 }, art)
}

/** The floor each part's ink must reach against its edge: text for the title, a control's icon for the toggle. */
const FLOOR: Record<InkEdgePart, number> = { brand: 4.5, control: 3 }

/**
 * The lowest contrast of one part's ink against its edge over every colour under the brand row in a theme palette and
 * scheme: every art colour at every strength, and the sidebar's fill the art fades into under the row. The filter draws
 * the ink over its own edge, so the ink is composited over the edge, not over the bare art.
 * @param palette - the theme palette.
 * @param scheme - the colour scheme.
 * @param part - the title or the toggle.
 * @param share - the edge's opacity, in percent.
 * @returns the contrast ratio.
 */
function worstContrast(palette: typeof PALETTES[number], scheme: Scheme, part: InkEdgePart, share: number): number {
  const values = themeValues(palette, scheme)
  const ink = lightInk(values)[part]
  const under = [...artColours(values, scheme), requireResolved(values, SIDEBAR_FILL)]
  return Math.min(...under.map((art) => {
    const ring = edged(values, share, ink, art)
    return contrast(over(ink, ring), ring)
  }))
}

const PARTS = Object.keys(INK_EDGE_OPACITY) as InkEdgePart[]

describe('the sidebar title over the header art', () => {
  for (const palette of PALETTES) {
    for (const scheme of SCHEMES) {
      it(`reads in its light ink against its own edge over every art colour, the title at 4.5:1 and the toggle at 3:1, in ${palette} (${scheme})`, () => {
        expect(artColours(themeValues(palette, scheme), scheme).length).toBeGreaterThan(100)
        for (const part of PARTS) {
          expect(worstContrast(palette, scheme, part, INK_EDGE_OPACITY[part]), part).toBeGreaterThanOrEqual(FLOOR[part])
        }
      })
    }
  }

  it('keeps each edge within four points of the lightest that reads, so it hides no more of the art than it must', () => {
    for (const part of PARTS) {
      const lighter = Math.min(...PALETTES.flatMap(palette => SCHEMES.map(scheme => worstContrast(palette, scheme, part, INK_EDGE_OPACITY[part] - 4))))
      expect(lighter, part).toBeLessThan(FLOOR[part])
    }
  })

  it('fails without an edge, so the check reaches colours that need each', () => {
    expect(worstContrast(PALETTES[0], 'light', 'brand', 0)).toBeLessThan(4.5)
    expect(worstContrast(PALETTES[0], 'dark', 'brand', 0)).toBeLessThan(4.5)
    expect(Math.min(...PALETTES.flatMap(palette => SCHEMES.map(scheme => worstContrast(palette, scheme, 'control', 0))))).toBeLessThan(3)
  })

  it('reads the ink from upstream\'s light rule, which draws the brand and the toggle\'s icon through the edge\'s ids', () => {
    expect(LIGHT_RULE).toContain('--dsw-alias-label-primary')
    const target = (id: string): string | undefined => new RegExp(`([^{}]+)\\{[^{}]*filter:\\s*url\\('#${id}'\\)[^{}]*\\}`).exec(SIDEBAR_ROOT)?.[1]?.trim()
    expect(target(INK_EDGE_IDS.brand)).toMatch(/\.brandIdentity$/)
    expect(target(INK_EDGE_IDS.control)).toMatch(/\.toggle svg$/)
  })

  it('draws each edge filter from the edge\'s token at its part\'s share, grown by the radius, with the ink on top', () => {
    const { container } = render(<InkEdgeFilters ids={{ brand: 'b', control: 'c' }} />)
    for (const [part, id] of [['brand', 'b'], ['control', 'c']] as const) {
      const filter = container.querySelector(`filter[id="${id}"]`)
      const grown = filter?.querySelector('feMorphology')
      expect([grown?.getAttribute('in'), grown?.getAttribute('operator'), grown?.getAttribute('radius')], part).toEqual(['SourceAlpha', 'dilate', String(INK_EDGE_RADIUS)])
      const edge = filter?.querySelector('feComposite[in2="grown"]')
      expect(edge?.getAttribute('result'), part).toBe('edge')
      const fill = edge?.previousElementSibling
      expect(fill?.getAttribute('style'), part).toBe(`flood-color: var(${INK_EDGE_TOKEN}); flood-opacity: ${String(INK_EDGE_OPACITY[part] / 100)};`)
      expect([...filter?.querySelectorAll('feMergeNode') ?? []].map(node => node.getAttribute('in')).slice(-2), part).toEqual(['edge', 'SourceGraphic'])
    }
  })

  it('mounts the edge\'s filters under the ids upstream names behind every art behind the sidebar\'s top, unmarked so the row turns light', () => {
    for (const headerArt of HEADER_ARTS.filter(art => art !== 'none')) {
      const { container } = render(<HeaderArt useSettings={settingsOf({ headerArt, artStyle: 'artwork' })} />)
      const ids = [...container.querySelectorAll('[data-ink-edge] filter')].map(filter => filter.id)
      expect(ids, headerArt).toEqual(PARTS.map(part => INK_EDGE_IDS[part]))
      expect(container.querySelector('[data-backdrop-plain]'), headerArt).toBeNull()
      cleanup()
    }
  })

  it('mounts no edge for no art or for the pill beside the name, where the title sits on the sidebar', () => {
    for (const artStyle of ART_STYLES) {
      const none = render(<HeaderArt useSettings={settingsOf({ headerArt: 'none', artStyle })} />)
      expect(none.container.childElementCount).toBe(0)
      cleanup()
    }
    const pill = render(<HeaderArt useSettings={settingsOf({ artStyle: 'pill' })} />)
    expect(pill.container.querySelector('[data-ink-edge]')).toBeNull()
    expect(pill.container.querySelector('[data-backdrop-plain]')).not.toBeNull()
  })

  it('finds no edge in the art alone', () => {
    const { container } = render(<StageBackdrop scene="blueprint" palette="accent" />)
    expect(container.querySelector('[data-ink-edge]')).toBeNull()
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
