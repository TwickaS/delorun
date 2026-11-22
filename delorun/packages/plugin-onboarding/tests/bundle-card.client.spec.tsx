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
    const { container } = render(<ul><AddableCard services={stepServices()} state="installing" progress={0.4} title="Pi" description="About it" onAdd={vi.fn()} /></ul>)
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

describe('the speed of a package being added', () => {
  const MB = 1_000_000

  it('shows the speed and the time left under the card once the queue reports bytes a second apart, keeping the line\'s height before', () => {
    vi.useFakeTimers()
    const source = createFakeDownloadsSource([{ key: 'pi', state: 'downloading', receivedBytes: 1 * MB, totalBytes: 20 * MB }])
    const withdraw = provideDownloadsSource(source)
    try {
      const bundles = installerFake({ pi: { state: 'installing' } })
      const { container } = render(<ul><BundleCard name="pi" title="Pi" description="About it" services={stepServices({ bundles: bundles.installer })} /></ul>)
      const line = (): Element | null => container.querySelector('p[class*="rate"]')
      expect(line()?.hasAttribute('data-empty')).toBe(true)
      act(() => { vi.advanceTimersByTime(1000) })
      act(() => { source.update('pi', { receivedBytes: 5 * MB }) })
      expect(line()?.textContent).toBe('4.0 MB/s · ~3.8s left')
      expect(line()?.hasAttribute('data-empty')).toBe(false)
      expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25')
      // A download that stands still shows no speed, and the line keeps its place.
      act(() => { vi.advanceTimersByTime(3000) })
      expect(line()?.hasAttribute('data-empty')).toBe(true)
    } finally {
      withdraw()
      vi.useRealTimers()
    }
  })

  it('shows no speed line once the package is added', () => {
    const { container } = render(<ul><AddableCard services={stepServices()} state="installed" rate="4.0 MB/s" title="Pi" description={undefined} onAdd={vi.fn()} /></ul>)
    expect(container.querySelector('p[class*="rate"]')).toBeNull()
  })
})
