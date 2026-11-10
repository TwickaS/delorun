// @vitest-environment jsdom
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { en } from '../src/client/locales.ts'
import { SidebarSettingsSection } from '../src/client/SettingsSection.tsx'
import { TITLE_SCRIM_TOKEN } from '../src/client/StageArt.tsx'
import { ART_PALETTES, DEFAULT_SIDEBAR_SETTINGS, HEADER_ARTS, MAX_ART_SEED, type SidebarSettings } from '../src/config.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const t = makeTranslate(en)

type Set = ConfigForm<SidebarSettings>['set']

/** A form over a fixed snapshot whose writes go to `set`. */
function formOf(value: SidebarSettings | undefined, set: Set = () => Promise.resolve(true), writable = true): ConfigForm<SidebarSettings> {
  const snapshot: ConfigFormSnapshot<SidebarSettings> = {
    status: value === undefined ? 'unavailable' : 'ready', value, base: undefined, user: undefined, revision: 1, writable,
  }
  return { getSnapshot: () => snapshot, subscribe: () => () => {}, set, unset: () => Promise.resolve(true), mutate: () => Promise.resolve(true) }
}

/** Renders the section over `settings`. */
function renderSection(settings: ConfigForm<SidebarSettings>) {
  return render(<SidebarSettingsSection t={t} settings={settings} />)
}

/** A set that records its calls and succeeds. */
const recordingSet = () => vi.fn<Set>(() => Promise.resolve(true))

const art = (name: string) => within(screen.getByRole('radiogroup', { name: en['settings.art'] })).getByRole('radio', { name })
const shuffle = () => screen.getByRole('button', { name: en['settings.art.shuffle'] }) as HTMLButtonElement
const slider = () => screen.getByRole('slider', { name: en['settings.width'] }) as HTMLInputElement
const block = (container: HTMLElement, id: string) => container.querySelector(`[aria-labelledby="delo-sidebar-${id}"]`)

describe('Settings → Sidebar choices', () => {
  it('shows the stored choices and saves each one picked', () => {
    const set = recordingSet()
    renderSection(formOf(DEFAULT_SIDEBAR_SETTINGS, set))
    expect(art(en['settings.art.blueprint']).getAttribute('aria-checked')).toBe('true')
    expect(art(en['settings.art.night']).getAttribute('aria-checked')).toBe('false')
    fireEvent.click(art(en['settings.art.night']))
    fireEvent.click(screen.getByRole('radio', { name: en['settings.palette.ocean'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['settings.view.folders'] }))
    fireEvent.click(screen.getByRole('switch', { name: en['settings.working'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['settings.strength.subtle'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['settings.style.pill'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['settings.sort.created'] }))
    fireEvent.click(screen.getByRole('switch', { name: en['settings.confirmUnpin'] }))
    expect(set.mock.calls).toEqual([
      ['headerArt', 'night'], ['artPalette', 'ocean'], ['view', 'folders'], ['workingShelf', false], ['artStrength', 'subtle'], ['artStyle', 'pill'],
      ['sort', 'created'], ['confirmUnpin', true],
    ])
    expect(screen.getByText(en['settings.credit'])).toBeTruthy()
  })

  it('does not save the art or the palette that is already chosen', () => {
    const set = recordingSet()
    renderSection(formOf(DEFAULT_SIDEBAR_SETTINGS, set))
    fireEvent.click(art(en['settings.art.blueprint']))
    fireEvent.click(screen.getByRole('radio', { name: en['settings.palette.accent'] }))
    expect(set).not.toHaveBeenCalled()
  })

  it('falls back to the defaults while no settings are stored', () => {
    const set = recordingSet()
    renderSection(formOf(undefined, set))
    expect(art(en[`settings.art.${DEFAULT_SIDEBAR_SETTINGS.headerArt}`]).getAttribute('aria-checked')).toBe('true')
    expect(slider().value).toBe(String(DEFAULT_SIDEBAR_SETTINGS.width))
    fireEvent.click(art(en['settings.art.none']))
    expect(set).toHaveBeenCalledWith('headerArt', 'none')
  })

  it('mutes the art settings, and only those, while the header art is none', () => {
    const { container } = renderSection(formOf({ ...DEFAULT_SIDEBAR_SETTINGS, headerArt: 'none' }))
    expect(['palette', 'strength', 'style'].map(id => block(container, id)?.getAttribute('data-muted'))).toEqual(['true', 'true', 'true'])
    expect(['art', 'view', 'sort', 'width'].map(id => block(container, id)?.getAttribute('data-muted'))).toEqual([null, null, null, null])
    cleanup()
    const shown = renderSection(formOf(DEFAULT_SIDEBAR_SETTINGS))
    expect(['palette', 'strength', 'style'].map(id => block(shown.container, id)?.getAttribute('data-muted'))).toEqual(['false', 'false', 'false'])
  })

  it('offers nothing to change while the settings are read-only', () => {
    const set = recordingSet()
    renderSection(formOf(DEFAULT_SIDEBAR_SETTINGS, set, false))
    const controls = [
      art(en['settings.art.night']), screen.getByRole('radio', { name: en['settings.palette.ocean'] }), shuffle(), slider(),
      screen.getByRole('button', { name: '280' }), screen.getByRole('switch', { name: en['settings.working'] }),
      screen.getByRole('tab', { name: en['settings.sort.created'] }),
    ]
    for (const control of controls) expect((control as HTMLButtonElement).disabled || control.getAttribute('aria-disabled') === 'true').toBe(true)
    fireEvent.click(art(en['settings.art.night']))
    expect(set).not.toHaveBeenCalled()
  })
})

describe('Settings → Sidebar shuffle', () => {
  it('is available for generated scenes only', () => {
    const { rerender } = renderSection(formOf({ ...DEFAULT_SIDEBAR_SETTINGS, headerArt: 'waves' }))
    expect(shuffle().disabled).toBe(false)
    for (const headerArt of ['none', 'night', 'blueprint'] as const) {
      rerender(<SidebarSettingsSection t={t} settings={formOf({ ...DEFAULT_SIDEBAR_SETTINGS, headerArt })} />)
      expect(shuffle().disabled).toBe(true)
    }
  })

  it('saves a new seed from 1 up to the largest allowed', () => {
    const set = recordingSet()
    const random = vi.spyOn(Math, 'random')
    renderSection(formOf({ ...DEFAULT_SIDEBAR_SETTINGS, headerArt: 'aurora' }, set))
    random.mockReturnValueOnce(0)
    fireEvent.click(shuffle())
    random.mockReturnValueOnce(0.5)
    fireEvent.click(shuffle())
    random.mockReturnValueOnce(1 - Number.EPSILON)
    fireEvent.click(shuffle())
    const seeds = set.mock.calls.map(([field, value]) => [field, value])
    expect(seeds.map(([field]) => field)).toEqual(['artSeed', 'artSeed', 'artSeed'])
    const values = seeds.map(([, value]) => value as number)
    expect(values[0]).toBe(1)
    for (const value of values) {
      expect(Number.isInteger(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(1)
      expect(value).toBeLessThanOrEqual(MAX_ART_SEED)
    }
    expect(values[1]).toBeGreaterThan(1_000_000_000)
  })
})

describe('Settings → Sidebar width', () => {
  it('moves freely, snaps to a notch nearby, and saves when the slider is let go by pointer or key', () => {
    const set = recordingSet()
    renderSection(formOf(DEFAULT_SIDEBAR_SETTINGS, set))
    expect(slider().value).toBe('256')
    fireEvent.change(slider(), { target: { value: '340' } })
    expect(screen.getByText('340 px')).toBeTruthy()
    expect(set).not.toHaveBeenCalled()
    fireEvent.pointerUp(slider())
    fireEvent.change(slider(), { target: { value: '276' } })
    expect(screen.getByText('280 px')).toBeTruthy()
    fireEvent.keyUp(slider())
    expect(set.mock.calls).toEqual([['width', 340], ['width', 280]])
  })

  it('saves a width left by moving focus away, and nothing when the width did not change', () => {
    const set = recordingSet()
    renderSection(formOf(DEFAULT_SIDEBAR_SETTINGS, set))
    fireEvent.blur(slider())
    fireEvent.change(slider(), { target: { value: '256' } })
    fireEvent.blur(slider())
    expect(set).not.toHaveBeenCalled()
    fireEvent.change(slider(), { target: { value: '300' } })
    fireEvent.blur(slider())
    expect(set.mock.calls).toEqual([['width', 300]])
  })

  it('jumps to a notch from its button, and leaves the notch the sidebar already has', () => {
    const set = recordingSet()
    renderSection(formOf(DEFAULT_SIDEBAR_SETTINGS, set))
    expect(screen.getByRole('button', { name: '256' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '256' }))
    expect(set).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '280' }))
    expect(set.mock.calls).toEqual([['width', 280]])
  })
})

describe('Settings → Sidebar failures', () => {
  const notice = () => screen.queryByText(en['settings.failed'])

  it('shows a notice when a choice is refused, and a new write clears it', async () => {
    const set = vi.fn<Set>().mockResolvedValueOnce(false).mockResolvedValue(true)
    renderSection(formOf(DEFAULT_SIDEBAR_SETTINGS, set))
    await act(async () => { fireEvent.click(art(en['settings.art.night'])) })
    expect(notice()).not.toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () => { fireEvent.click(art(en['settings.art.none'])) })
    expect(notice()).toBeNull()
  })

  it('shows a notice when a write is rejected', async () => {
    renderSection(formOf(DEFAULT_SIDEBAR_SETTINGS, () => Promise.reject(new Error('down'))))
    await act(async () => { fireEvent.click(art(en['settings.art.night'])) })
    expect(notice()).not.toBeNull()
  })

  it('removes the notice once it has faded', async () => {
    vi.useFakeTimers()
    renderSection(formOf(DEFAULT_SIDEBAR_SETTINGS, () => Promise.resolve(false)))
    await act(async () => { fireEvent.click(art(en['settings.art.night'])) })
    expect(notice()).not.toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(notice()).toBeNull()
  })
})

describe('Settings → Sidebar names and parts', () => {
  it('names both header-art radio groups from the dictionary, not from a heading elsewhere on the page', () => {
    renderSection(formOf(DEFAULT_SIDEBAR_SETTINGS))
    for (const [name, size] of [[en['settings.art'], HEADER_ARTS.length], [en['settings.palette'], ART_PALETTES.length]] as const) {
      const group = screen.getByRole('radiogroup', { name })
      expect(group.getAttribute('aria-label')).toBe(name)
      expect(group.hasAttribute('aria-labelledby')).toBe(false)
      expect(within(group).getAllByRole('radio')).toHaveLength(size)
    }
  })

  it('offers the way back to the stock look nowhere in the section, since Appearance is its one place', () => {
    const { container } = renderSection(formOf(DEFAULT_SIDEBAR_SETTINGS))
    expect(container.textContent?.toLowerCase()).not.toContain('stock look')
    expect(screen.queryByRole('button', { name: /look/i })).toBeNull()
    expect(container.querySelector('#delo-sidebar-stock')).toBeNull()
  })

  it('previews the brand on the title plate over art, and plain when the art is none', () => {
    renderSection(formOf(DEFAULT_SIDEBAR_SETTINGS))
    const brands = screen.getAllByText(en['settings.preview.brand'])
    expect(brands).toHaveLength(HEADER_ARTS.length)
    const backgrounds = brands.map(brand => brand.style.background)
    expect(backgrounds.filter(background => background === `var(${TITLE_SCRIM_TOKEN})`)).toHaveLength(HEADER_ARTS.length - 1)
    expect(backgrounds[HEADER_ARTS.indexOf('none')]).toBe('')
  })
})

describe('Settings → Sidebar swipe strip', () => {
  const sizes = { clientWidth: 300, scrollWidth: 900 }
  const rect = (width: number): DOMRect => ({ left: 0, width, top: 0, right: width, bottom: 32, height: 32, x: 0, y: 0, toJSON: () => ({}) })

  /** Reports `sizes` for every element until the test ends. */
  function mockSizes(): void {
    for (const name of ['clientWidth', 'scrollWidth'] as const) {
      const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => sizes[name] })
      restores.push(() => {
        if (original === undefined) Reflect.deleteProperty(HTMLElement.prototype, name)
        else Object.defineProperty(HTMLElement.prototype, name, original)
      })
    }
  }

  const restores: Array<() => void> = []
  afterEach(() => {
    for (const restore of restores.splice(0)) restore()
    sizes.clientWidth = 300
    sizes.scrollWidth = 900
  })

  const rows = () => screen.getByRole('radiogroup', { name: en['settings.art'] })
  const thumbOf = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-thumb]')
  const bar = (container: HTMLElement): HTMLElement => {
    const found = thumbOf(container)?.parentElement
    if (found === null || found === undefined) throw new Error('no swipe bar')
    return found
  }

  it('shows how much of the row is in view and where, and fades the edge where more waits', () => {
    mockSizes()
    const { container } = renderSection(formOf(DEFAULT_SIDEBAR_SETTINGS))
    const thumb = thumbOf(container)
    expect([thumb?.style.left, thumb?.style.width.slice(0, 5), rows().getAttribute('data-more-before'), rows().getAttribute('data-more-after')])
      .toEqual(['0%', '33.33', 'false', 'true'])
    rows().scrollLeft = 300
    fireEvent.scroll(rows())
    expect([thumb?.style.left.slice(0, 5), rows().getAttribute('data-more-before'), rows().getAttribute('data-more-after')]).toEqual(['33.33', 'true', 'true'])
    rows().scrollLeft = 600
    fireEvent.scroll(rows())
    expect([rows().getAttribute('data-more-before'), rows().getAttribute('data-more-after')]).toEqual(['true', 'false'])
  })

  it('shows no bar when every choice fits', () => {
    mockSizes()
    sizes.scrollWidth = 300
    const { container } = renderSection(formOf(DEFAULT_SIDEBAR_SETTINGS))
    expect(thumbOf(container)).toBeNull()
    expect([rows().getAttribute('data-more-before'), rows().getAttribute('data-more-after')]).toEqual(['false', 'false'])
  })

  it('shows no bar when the row has no width yet', () => {
    const { container } = renderSection(formOf(DEFAULT_SIDEBAR_SETTINGS))
    expect(thumbOf(container)).toBeNull()
  })

  it('measures again when the row is resized, and stops watching when the section goes', () => {
    class Observer {
      static readonly all: Observer[] = []
      readonly observe = vi.fn()
      readonly disconnect = vi.fn()
      readonly notify: () => void

      constructor(notify: () => void) {
        this.notify = notify
        Observer.all.push(this)
      }
    }
    vi.stubGlobal('ResizeObserver', Observer)
    mockSizes()
    sizes.scrollWidth = 300
    const { container, unmount } = renderSection(formOf(DEFAULT_SIDEBAR_SETTINGS))
    const [observer] = Observer.all
    expect(observer?.observe).toHaveBeenCalledWith(rows())
    expect(thumbOf(container)).toBeNull()
    sizes.scrollWidth = 900
    act(() => { observer?.notify() })
    expect(thumbOf(container)).not.toBeNull()
    unmount()
    expect(observer?.disconnect).toHaveBeenCalled()
  })

  it('moves the row by the same share when the bar is pressed', () => {
    mockSizes()
    const { container } = renderSection(formOf(DEFAULT_SIDEBAR_SETTINGS))
    const track = bar(container)
    track.getBoundingClientRect = () => rect(300)
    track.setPointerCapture = vi.fn()
    fireEvent.pointerDown(track, { clientX: 300, pointerId: 1 })
    expect(rows().scrollLeft).toBe(750)
    expect(track.setPointerCapture).toHaveBeenCalledWith(1)
  })

  it('moves the row with the thumb while it is dragged, and stops when it is let go or cancelled', () => {
    mockSizes()
    const { container } = renderSection(formOf(DEFAULT_SIDEBAR_SETTINGS))
    rows().scrollLeft = 300
    fireEvent.scroll(rows())
    const track = bar(container)
    track.getBoundingClientRect = () => rect(300)
    track.setPointerCapture = vi.fn()
    const thumb = thumbOf(container) as HTMLElement
    fireEvent.pointerDown(thumb, { clientX: 150, pointerId: 1 })
    expect(rows().scrollLeft).toBe(300)
    fireEvent.pointerMove(track, { clientX: 240 })
    expect(rows().scrollLeft).toBeCloseTo(570)
    fireEvent.pointerUp(track)
    fireEvent.pointerMove(track, { clientX: 30 })
    expect(rows().scrollLeft).toBeCloseTo(570)
    fireEvent.pointerDown(thumb, { clientX: 150, pointerId: 2 })
    fireEvent.pointerMove(track, { clientX: 210 })
    expect(rows().scrollLeft).toBeCloseTo(480)
    fireEvent.pointerCancel(track)
    fireEvent.pointerMove(track, { clientX: 30 })
    expect(rows().scrollLeft).toBeCloseTo(480)
  })

  it('ignores a press on a bar that has no width', () => {
    mockSizes()
    const { container } = renderSection(formOf(DEFAULT_SIDEBAR_SETTINGS))
    const track = bar(container)
    track.setPointerCapture = vi.fn()
    fireEvent.pointerDown(track, { clientX: 100, pointerId: 1 })
    expect(rows().scrollLeft).toBe(0)
    expect(track.setPointerCapture).not.toHaveBeenCalled()
  })
})
