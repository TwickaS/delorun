// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { createFakeDownloadsSource, provideDownloadsSource } from '@delorun/plugin-downloads/row'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AddableCard, BundleCard } from '../src/client/steps/BundleCard.tsx'
import { en } from '../src/client/locales.ts'
import type { BundleState } from '../src/client/bundles.ts'
import { installerFake, stepServices } from './fixtures.client.ts'

afterEach(cleanup)

const draw = (state: BundleState, remote: boolean) => {
  const onAdd = vi.fn()
  render(<ul><AddableCard services={stepServices({ remote })} state={state} title="Pi" description={undefined} onAdd={onAdd} /></ul>)
  return onAdd
}

describe('an addable card on a phone', () => {
  it('offers Add and Retry as on the computer, with no add-at-the-computer line', () => {
    draw('available', true)
    expect(screen.getByRole('button', { name: /Pi/ })).toBeTruthy()
    cleanup()
    draw('failed', true)
    expect(screen.getByRole('button', { name: en['bundle.retry'] })).toBeTruthy()
  })

  it('leaves an added package as it is', () => {
    draw('installed', true)
    expect(screen.getByText(en['bundle.added'])).toBeTruthy()
  })
})

describe('an unavailable card', () => {
  it('blames the computer only for a platform limit, and gives the reason a Host without plugin packs reports', () => {
    draw('unavailable', false)
    expect(screen.getByText(en['bundle.unavailable'])).toBeTruthy()
    cleanup()
    render(<ul><AddableCard services={stepServices({ remote: false })} state="unavailable" packsReason="Delorun is not running from an installed release." title="Pi" description={undefined} onAdd={vi.fn()} /></ul>)
    expect(screen.getByText('Not available here. Delorun is not running from an installed release.')).toBeTruthy()
    expect(screen.queryByText(en['bundle.unavailable'])).toBeNull()
  })
})

describe('the state slot of a row', () => {
  it('holds Add, Adding and Added in one slot of the same class, on the right of the row', () => {
    const slots = (['available', 'installing', 'installed'] as const).map((state) => {
      const { container } = render(<ul><AddableCard services={stepServices()} state={state} title="Pi" description={undefined} onAdd={vi.fn()} /></ul>)
      const slot = container.querySelector('[class*="slot"]')
      const text = slot?.textContent
      cleanup()
      return [state, slot !== null, text]
    })
    expect(slots).toEqual([['available', true, en['bundle.add']], ['installing', true, en['bundle.adding']], ['installed', true, `✓ ${en['bundle.added']}`]])
  })

  it('puts the Adding words in the slot, not in a line under the description, and shows the download when the queue knows it', () => {
    const { container } = render(<ul><AddableCard services={stepServices()} state="installing" download={{ progress: 0.4, status: '40%' }} title="Pi" description="About it" onAdd={vi.fn()} /></ul>)
    expect(container.querySelector('[class*="slot"]')?.textContent).toContain(en['bundle.adding'])
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('40')
  })

  it('draws Add as a button with a plus and the label Add, named for the plugin', () => {
    const { container } = render(<ul><AddableCard services={stepServices()} state="available" title="Pi" description={undefined} onAdd={vi.fn()} /></ul>)
    const button = screen.getByRole('button', { name: /Pi/ })
    expect(button.querySelector('svg')).not.toBeNull()
    expect(button.textContent).toBe(en['bundle.add'])
    expect(container.querySelectorAll('[class*="slot"]').length).toBeGreaterThan(0)
  })
})

describe('a package being added', () => {
  const MB = 1_000_000

  it('draws the download under the card with the panel\'s status, its speed and time left once bytes arrive a second apart', () => {
    vi.useFakeTimers()
    const source = createFakeDownloadsSource([{ key: 'pi', state: 'downloading', receivedBytes: 1 * MB, totalBytes: 20 * MB }])
    const withdraw = provideDownloadsSource(source)
    try {
      const bundles = installerFake({ pi: { state: 'installing' } })
      const { container } = render(<ul><BundleCard name="pi" title="Pi" description="About it" services={stepServices({ bundles: bundles.installer })} /></ul>)
      const line = (): string | null | undefined => container.querySelector('p[class*="rate"]')?.textContent
      // The slot keeps the words; the bar has the card's width under it.
      expect(container.querySelector('[class*="slot"]')?.textContent).toBe(en['bundle.adding'])
      expect(container.querySelector('[class*="slot"] [role="progressbar"]')).toBeNull()
      expect(screen.getByRole('progressbar', { name: 'Pi' }).getAttribute('aria-valuenow')).toBe('5')
      expect(line()).toBe('5%')
      act(() => { vi.advanceTimersByTime(1000) })
      act(() => { source.update('pi', { receivedBytes: 5 * MB }) })
      expect(line()).toBe('25% · 4.0 MB/s · ~3.8s left')
      expect(screen.getByRole('progressbar', { name: 'Pi' }).getAttribute('aria-valuetext')).toBe('25%')
      // A download that stands still drops the speed and keeps its percentage.
      act(() => { vi.advanceTimersByTime(3000) })
      expect(line()).toBe('25%')
    } finally {
      withdraw()
      vi.useRealTimers()
    }
  })

  it('says a package waits its turn while others download, with an empty track', () => {
    const source = createFakeDownloadsSource([
      { key: 'a', state: 'downloading', receivedBytes: 1, totalBytes: 10 },
      { key: 'pi', state: 'queued', receivedBytes: 0, position: 2 },
    ])
    const withdraw = provideDownloadsSource(source)
    try {
      const bundles = installerFake({ pi: { state: 'installing' } })
      const { container } = render(<ul><BundleCard name="pi" title="Pi" description={undefined} services={stepServices({ bundles: bundles.installer })} /></ul>)
      expect(container.querySelector('p[class*="rate"]')?.textContent).toBe('Waiting · 1 ahead')
      expect(container.querySelector('[class*="download"] [class*="bar"]')).not.toBeNull()
      expect(screen.queryByRole('progressbar')).toBeNull()
    } finally {
      withdraw()
    }
  })

  it('draws no download block for an add the install queue does not list, and none once the package is added', () => {
    const adding = render(<ul><AddableCard services={stepServices()} state="installing" title="Pi" description={undefined} onAdd={vi.fn()} /></ul>)
    expect(adding.container.querySelector('[class*="download"]')).toBeNull()
    cleanup()
    const { container } = render(<ul><AddableCard services={stepServices()} state="installed" download={{ progress: 1, status: 'Added' }} title="Pi" description={undefined} onAdd={vi.fn()} /></ul>)
    expect(container.querySelector('[class*="download"]')).toBeNull()
  })
})
