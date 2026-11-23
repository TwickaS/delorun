// @vitest-environment jsdom
/**
 * A download's speed and time left in the panel's rows: measured in the page from the received bytes, shown once two
 * readings a second apart exist, the time left only with a known size, and nothing at zero, for a stalled download or
 * outside the download itself.
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ItemList } from '../src/client/Items.tsx'
import { fallbackTranslate as t } from '../src/client/locales.ts'
import { Figures } from '../src/client/Figures.tsx'
import { rateText } from '../src/client/rate.ts'
import { createFakeDownloadsSource, type DownloadItem, type FakeDownloadsSource } from '../src/client/source.ts'
import { useSyncExternalStore } from 'react'

const MB = 1_000_000

/** The list over a live source, as the card and the sheet draw it. */
function List({ source }: { readonly source: FakeDownloadsSource }) {
  const items = useSyncExternalStore(source.subscribe, source.snapshot)
  return <ItemList items={items} source={source} t={t} tone="card" label="Plugins" />
}

const downloading = (patch: Partial<DownloadItem> = {}): DownloadItem => ({ key: 'pi', title: 'Pi', state: 'downloading', receivedBytes: 0, totalBytes: 20 * MB, ...patch })
const status = (): string => document.querySelector('[class*="status"]')?.textContent ?? ''
const later = (ms: number): void => { act(() => { vi.advanceTimersByTime(ms) }) }

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('the speed of a download in the panel', () => {
  it('reads the same in every surface that shows the download, however late one opens', () => {
    const source = createFakeDownloadsSource([downloading({ receivedBytes: 1 * MB })])
    render(<List source={source} />)
    later(500)
    act(() => { source.update('pi', { receivedBytes: 3 * MB }) })
    later(500)
    act(() => { source.update('pi', { receivedBytes: 5 * MB }) })
    // A second surface (the sheet beside a setup card) opens after the first readings, and reads the same meter.
    render(<List source={source} />)
    const statuses = (): string[] => [...document.querySelectorAll('[class*="status"]')].map(each => each.textContent ?? '')
    expect(statuses()).toEqual(['25% · 4.0 MB/s · ~3.8s left', '25% · 4.0 MB/s · ~3.8s left'])
    later(1000)
    act(() => { source.update('pi', { receivedBytes: 9 * MB }) })
    expect(new Set(statuses()).size).toBe(1)
  })

  it('appears once two readings a second apart show bytes arriving, with the time left for a known size', () => {
    const source = createFakeDownloadsSource([downloading({ receivedBytes: 1 * MB })])
    render(<List source={source} />)
    expect(status()).toBe('5%')
    later(500)
    act(() => { source.update('pi', { receivedBytes: 3 * MB }) })
    expect(status()).toBe('15%')
    later(500)
    act(() => { source.update('pi', { receivedBytes: 5 * MB }) })
    expect(status()).toBe('25% · 4.0 MB/s · ~3.8s left')
    // The progress bar's text keeps to the percentage.
    expect(screen.getByRole('progressbar', { name: 'Pi' }).getAttribute('aria-valuetext')).toBe('25%')
  })

  it('shows the bytes and the speed but no time left while the size is unknown', () => {
    const { totalBytes: _size, ...unsized } = downloading({ receivedBytes: 2 * MB })
    const source = createFakeDownloadsSource([unsized])
    render(<List source={source} />)
    expect(status()).toBe('2.0 MB')
    later(1000)
    act(() => { source.update('pi', { receivedBytes: 6 * MB }) })
    expect(status()).toBe('6.0 MB · 4.0 MB/s')
  })

  it('shows no speed while nothing has arrived, or for a zero size', () => {
    const source = createFakeDownloadsSource([downloading()])
    render(<List source={source} />)
    later(3000)
    expect(status()).toBe('0%')
    act(() => { source.update('pi', { totalBytes: 0 }) })
    later(2000)
    expect(status()).toBe('Downloading')
  })

  it('drops the speed and the time left once a download stands still, and brings them back when bytes arrive', () => {
    const source = createFakeDownloadsSource([downloading({ receivedBytes: 1 * MB })])
    render(<List source={source} />)
    later(1000)
    act(() => { source.update('pi', { receivedBytes: 5 * MB }) })
    expect(status()).toBe('25% · 4.0 MB/s · ~3.8s left')
    later(3000)
    expect(status()).toBe('25%')
    act(() => { source.update('pi', { receivedBytes: 6 * MB }) })
    later(1000)
    expect(status()).toMatch(/^30% · .+ MB\/s · ~.+ left$/u)
  })

  it('leaves the speed out once the download is checked or installed', () => {
    const source = createFakeDownloadsSource([downloading({ receivedBytes: 1 * MB })])
    render(<List source={source} />)
    later(1000)
    act(() => { source.update('pi', { receivedBytes: 5 * MB }) })
    act(() => { source.update('pi', { state: 'verifying', receivedBytes: 20 * MB }) })
    expect(status()).toBe('Checking')
  })
})

describe('the words for a rate', () => {
  it('say nothing without a speed, the speed alone without a time left, and both with one', () => {
    expect(rateText({}, t)).toBe('')
    expect(rateText({ speed: 6_700_000 }, t)).toBe('6.7 MB/s')
    expect(rateText({ speed: 6_700_000, secondsLeft: 125 }, t)).toBe('6.7 MB/s · ~2m 05s left')
  })
})

describe('the figures of a status', () => {
  it('keep the digits fixed-width and the decimal point, spaces and units in the font\'s own widths', () => {
    const { container } = render(<p><Figures text="25% · 5.0 MB/s · ~34s left" /></p>)
    expect(container.textContent).toBe('25% · 5.0 MB/s · ~34s left')
    const fixed = [...container.querySelectorAll<HTMLElement>('[data-figures]')]
    expect(fixed.map(each => each.textContent)).toEqual(['25', '5', '0', '34'])
    expect(fixed.every(each => each.style.fontVariantNumeric === 'tabular-nums')).toBe(true)
  })

  it('draw a panel row\'s status through them', () => {
    const source = createFakeDownloadsSource([downloading({ receivedBytes: 1 * MB })])
    render(<List source={source} />)
    expect(document.querySelector('[class*="status"] [data-figures]')?.textContent).toBe('5')
  })
})
