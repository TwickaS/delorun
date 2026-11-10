// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
// Test-only imports of the theme's palette generator from its source, so the spec resolves each palette's real token values.
import { DEFAULT_SETTINGS, PALETTES } from '../../plugin-theme/src/config.ts'
import { contrast } from '../../plugin-theme/src/palette/color.ts'
import { applyLayers, requireResolved } from '../../plugin-theme/src/palette/generate.ts'
import { themeLayers } from '../../plugin-theme/src/palette/layers.ts'
import { STOCK_TOKENS } from '../../plugin-theme/src/palette/stock.ts'
import { HeaderArt } from '../src/client/HeaderArt.tsx'
import { StageBackdrop, TITLE_SCRIM_TOKEN } from '../src/client/StageArt.tsx'
import { ART_STYLES, DEFAULT_SIDEBAR_SETTINGS, HEADER_ARTS, type SidebarSettings } from '../src/config.ts'

afterEach(cleanup)

/** The text colour the sidebar gives its title over art, and over the sidebar itself (the shell's rule for a backdrop with or without `data-backdrop-plain`). */
const TEXT_OVER_ART = '--dsw-static-neutral-bluish-00'
const TEXT_PLAIN = '--dsw-alias-label-primary'
const SIDEBAR_FILL = '--dsw-specific-sidebar-fill'

const settingsOf = (fields: Partial<SidebarSettings>) => <R,>(select: (value: SidebarSettings) => R): R => select({ ...DEFAULT_SIDEBAR_SETTINGS, ...fields })

/**
 * What sits directly behind the title, read from what the art renders: the sidebar itself when nothing or a plain pill
 * renders, the title's plate when the plate renders, and nothing known when art renders without a plate.
 * @param container - the render of the seat.
 * @returns the title's text token and the token of the colour behind it, which is undefined when the art itself is behind the title.
 */
function behindTitle(container: HTMLElement): { text: string; behind: string | undefined } {
  const plain = container.childElementCount === 0 || container.querySelector('[data-backdrop-plain]') !== null
  if (plain) return { text: TEXT_PLAIN, behind: SIDEBAR_FILL }
  const background = container.querySelector<HTMLElement>('[data-title-scrim]')?.style.background
  return { text: TEXT_OVER_ART, behind: background === undefined ? undefined : /^var\((--[\w-]+)\)$/.exec(background)?.[1] }
}

describe('the sidebar title over the header art', () => {
  for (const palette of PALETTES) {
    for (const scheme of ['light', 'dark'] as const) {
      it(`reads at 4.5:1 or more on its plate for every header art and style, in ${palette} (${scheme})`, () => {
        const layers = themeLayers({ ...DEFAULT_SETTINGS, studioAdditions: true, palette })
        const values = applyLayers(STOCK_TOKENS, [layers.palette ?? {}, layers.accent ?? {}], scheme)
        for (const headerArt of HEADER_ARTS) {
          for (const artStyle of ART_STYLES) {
            const { container } = render(<HeaderArt useSettings={settingsOf({ headerArt, artStyle })} />)
            const { text, behind } = behindTitle(container)
            expect(behind, `${headerArt} ${artStyle}: something other than the art sits behind the title`).toBeDefined()
            const ratio = contrast(requireResolved(values, text), requireResolved(values, behind ?? ''))
            expect(ratio, `${headerArt} ${artStyle}: ${text} on ${behind ?? ''}`).toBeGreaterThanOrEqual(4.5)
            cleanup()
          }
        }
      })
    }
  }

  it('puts the plate under the title on every art behind the sidebar\'s top, filled with the theme token', () => {
    for (const headerArt of HEADER_ARTS.filter(art => art !== 'none')) {
      const { container } = render(<HeaderArt useSettings={settingsOf({ headerArt, artStyle: 'artwork' })} />)
      expect(behindTitle(container)).toEqual({ text: TEXT_OVER_ART, behind: TITLE_SCRIM_TOKEN })
      cleanup()
    }
  })

  it('finds the art itself behind the title when the plate is missing, which fails the contrast check', () => {
    const { container } = render(<StageBackdrop scene="blueprint" palette="accent" />)
    expect(behindTitle(container).behind).toBeUndefined()
  })

  it('draws no plate for no art or for the pill beside the name', () => {
    const none = render(<HeaderArt useSettings={settingsOf({ headerArt: 'none' })} />)
    expect(none.container.querySelector('[data-title-scrim]')).toBeNull()
    cleanup()
    const pill = render(<HeaderArt useSettings={settingsOf({ artStyle: 'pill' })} />)
    expect(pill.container.querySelector('[data-title-scrim]')).toBeNull()
  })

  it('keeps the secondary label, which the row\'s small text uses, at 4.5:1 on the surfaces of the list in every palette', () => {
    for (const palette of PALETTES) {
      for (const scheme of ['light', 'dark'] as const) {
        const layers = themeLayers({ ...DEFAULT_SETTINGS, studioAdditions: true, palette })
        const values = applyLayers(STOCK_TOKENS, [layers.palette ?? {}, layers.accent ?? {}], scheme)
        for (const surface of [SIDEBAR_FILL, '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1']) {
          const ratio = contrast(requireResolved(values, '--dsw-alias-label-secondary'), requireResolved(values, surface))
          expect(ratio, `${palette} ${scheme} on ${surface}`).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })
})
