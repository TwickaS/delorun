// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SIDEBAR_SETTINGS, type SidebarSettings } from '../src/config.ts'
import { GENERATIVE_SCENES, seededRandom } from '../src/client/GenerativeArt.tsx'
import { HeaderArt } from '../src/client/HeaderArt.tsx'
import { STAGE_PALETTES, STAGE_SCENES, StageBackdrop } from '../src/client/StageArt.tsx'

afterEach(cleanup)

/** Drop the generated ids, which differ between renders of identical art. */
const withoutIds = (html: string): string => html.replace(/id="[^"]+"|url\(#[^)]+\)/g, '')

const markup = (element: React.ReactElement): string => {
  const { container } = render(element)
  const html = container.innerHTML
  cleanup()
  return html
}

describe('the header art', () => {
  const settingsOf = (fields: Partial<SidebarSettings>) =>
    <R,>(select: (value: SidebarSettings) => R): R => select({ ...DEFAULT_SIDEBAR_SETTINGS, ...fields })

  it('draws the chosen scene in the chosen palette, or nothing for none', () => {
    const { container, rerender } = render(<HeaderArt useSettings={settingsOf({ headerArt: 'night', artPalette: 'rose' })} />)
    const art = container.firstElementChild
    expect([art?.getAttribute('data-scene'), art?.getAttribute('data-palette')]).toEqual(['night', 'rose'])
    expect(container.querySelector('[data-stage-art="nightly"]')).not.toBeNull()
    rerender(<HeaderArt useSettings={settingsOf({ headerArt: 'none' })} />)
    expect(container.innerHTML).toBe('')
  })

  it('draws at the chosen strength', () => {
    const { container } = render(<HeaderArt useSettings={settingsOf({ artStrength: 'vivid' })} />)
    expect(container.firstElementChild?.getAttribute('data-strength')).toBe('vivid')
    expect(container.firstElementChild?.getAttribute('data-fade')).toBe('true')
  })

  it('draws a pill that leaves the brand its colours, with the compact blueprint and no fade', () => {
    const { container } = render(<HeaderArt useSettings={settingsOf({ artStyle: 'pill', headerArt: 'blueprint' })} />)
    expect(container.firstElementChild?.hasAttribute('data-backdrop-plain')).toBe(true)
    const backdrop = container.querySelector('[data-scene="blueprint"]')
    expect(backdrop?.getAttribute('data-fade')).toBe('false')
    expect(backdrop?.querySelector('svg')?.getAttribute('viewBox')).toBe('64 0 8192 96')
  })

  it('draws a generated scene from the stored seed', () => {
    const { container } = render(<HeaderArt useSettings={settingsOf({ headerArt: 'waves', artSeed: 42 })} />)
    expect(container.querySelector('[data-stage-art="waves"]')).not.toBeNull()
  })
})

describe('the stage backdrop', () => {
  it('draws an svg for each scene, in each palette, hidden from assistive technology', () => {
    for (const scene of STAGE_SCENES) {
      for (const palette of STAGE_PALETTES) {
        const { container } = render(<StageBackdrop scene={scene} palette={palette} />)
        const backdrop = container.firstElementChild
        expect([backdrop?.getAttribute('data-scene'), backdrop?.getAttribute('data-palette'), backdrop?.getAttribute('aria-hidden')])
          .toEqual([scene, palette, 'true'])
        expect(container.querySelector('svg[data-stage-art]')).not.toBeNull()
        cleanup()
      }
    }
    expect(STAGE_SCENES).toHaveLength(8)
  })

  it('states whether it fades and how strongly it shows', () => {
    const { container, rerender } = render(<StageBackdrop scene="night" palette="blueprint" />)
    expect([container.firstElementChild?.getAttribute('data-fade'), container.firstElementChild?.getAttribute('data-strength')])
      .toEqual(['true', 'standard'])
    rerender(<StageBackdrop scene="night" palette="blueprint" fade={false} strength="subtle" />)
    expect([container.firstElementChild?.getAttribute('data-fade'), container.firstElementChild?.getAttribute('data-strength')])
      .toEqual(['false', 'subtle'])
  })

  it('shifts the night sky and the blueprint in a compact view', () => {
    const viewBox = (scene: 'night' | 'blueprint', compact: boolean) => {
      const { container } = render(<StageBackdrop scene={scene} palette="blueprint" compact={compact} />)
      const value = container.querySelector('svg')?.getAttribute('viewBox')
      cleanup()
      return value
    }
    expect([viewBox('night', false), viewBox('night', true)]).toEqual(['0 0 8192 96', '96 0 8192 96'])
    expect([viewBox('blueprint', false), viewBox('blueprint', true)]).toEqual(['0 0 8192 96', '64 0 8192 96'])
  })
})

describe('the generated scenes', () => {
  it('draw identical markup from the same seed and different markup from another', () => {
    for (const scene of GENERATIVE_SCENES) {
      const first = markup(<StageBackdrop scene={scene} palette="ocean" seed={5} />)
      const again = markup(<StageBackdrop scene={scene} palette="ocean" seed={5} />)
      const other = markup(<StageBackdrop scene={scene} palette="ocean" seed={6} />)
      expect(first).toContain(`data-stage-art="${scene}"`)
      expect(withoutIds(again)).toBe(withoutIds(first))
      expect(withoutIds(other)).not.toBe(withoutIds(first))
    }
  })

  it('define a blur filter for the aurora only', () => {
    for (const scene of GENERATIVE_SCENES) {
      const { container } = render(<StageBackdrop scene={scene} palette="blueprint" />)
      expect(container.querySelector('filter') !== null).toBe(scene === 'aurora')
      cleanup()
    }
  })

  it('draw from a seeded random source that repeats and stays in [0, 1)', () => {
    const first = seededRandom(1)
    const again = seededRandom(1)
    const values = Array.from({ length: 200 }, () => first())
    expect(values).toEqual(Array.from({ length: 200 }, () => again()))
    expect(values.every(value => value >= 0 && value < 1)).toBe(true)
    expect(seededRandom(2)()).not.toBe(values[0])
  })
})
