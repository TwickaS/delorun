// @vitest-environment jsdom
/** The downloads panel: the card, the phone row, the sheet and their states against the fake source. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DownloadsCard } from '../src/client/Card.tsx'
import { fallbackTranslate as t } from '../src/client/locales.ts'
import { useDownloadsModel } from '../src/client/model.ts'
import { DownloadsSheet, OnboardingDownloadsRow } from '../src/client/Phone.tsx'
import { createFakeDownloadsSource, type DownloadItem, type FakeDownloadsSource } from '../src/client/source.ts'

const item = (key: string, patch: Partial<DownloadItem> = {}): DownloadItem => ({ key, title: key, state: 'queued', receivedBytes: 0, ...patch })

/** Renders the card driven by the model hook, as the surface does. */
function Card({ source, summaryMs = 4000 }: { source: FakeDownloadsSource; summaryMs?: number }) {
  const model = useDownloadsModel(source, summaryMs)
  return <DownloadsCard model={model} source={source} t={t} />
}
function Sheet({ source }: { source: FakeDownloadsSource }) {
  const model = useDownloadsModel(source)
  return <DownloadsSheet model={model} source={source} t={t} />
}

const mixed = (): DownloadItem[] => [
  item('alpha', { state: 'downloading', receivedBytes: 40, totalBytes: 100 }),
  item('beta', { state: 'queued', position: 1 }),
  item('gamma', { state: 'waiting-for-unlock' }),
  item('delta', { state: 'verifying' }),
  item('eps', { state: 'ready' }),
]

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('the desktop card', () => {
  it('shows nothing while the queue is empty', () => {
    render(<Card source={createFakeDownloadsSource()} />)
    expect(document.querySelector('section')).toBeNull()
  })

  it('reads "Installing n of total" and shows each state', () => {
    render(<Card source={createFakeDownloadsSource(mixed())} />)
    expect(screen.getByRole('button', { name: /4 left to install/ })).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: 'alpha' }).getAttribute('aria-valuenow')).toBe('40')
    expect(screen.getByText('Waiting · next')).toBeTruthy()
    expect(screen.getByText('Not confirmed. Try again to confirm with Face ID or your PIN')).toBeTruthy()
    expect(screen.getByText('Checking')).toBeTruthy()
    expect(screen.getByText('Added')).toBeTruthy()
  })

  it('puts the accent on a running bar only', () => {
    render(<Card source={createFakeDownloadsSource(mixed())} />)
    expect(screen.getByRole('progressbar', { name: 'alpha' }).className).toMatch(/accent/)
    expect(screen.getByRole('progressbar', { name: 'beta' }).className).not.toMatch(/accent/)
    expect(document.querySelectorAll('[class*="accent"]').length).toBe(2)
  })

  it('collapses to one line and expands again', () => {
    render(<Card source={createFakeDownloadsSource(mixed())} />)
    const toggle = screen.getByRole('button', { name: /4 left to install/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(document.getElementById(toggle.getAttribute('aria-controls') ?? '')?.getAttribute('data-open')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })

  it('cancels a queued or running item', () => {
    const source = createFakeDownloadsSource(mixed())
    render(<Card source={source} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel beta' }))
    expect(source.calls).toEqual(['cancel:beta'])
    expect(screen.queryByText('Waiting · next')).toBeNull()
  })

  it('shows the summary when everything is added, then hides', () => {
    const source = createFakeDownloadsSource([item('a', { state: 'installing' }), item('b', { state: 'installing' })])
    render(<Card source={source} />)
    act(() => { source.set([item('a', { state: 'ready' }), item('b', { state: 'ready' })]) })
    expect(screen.getByRole('button', { name: /2 plugins added/ })).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('2 plugins added')
    act(() => { vi.advanceTimersByTime(3999) })
    expect(document.querySelector('section')).not.toBeNull()
    act(() => { vi.advanceTimersByTime(2) })
    expect(document.querySelector('section')).toBeNull()
  })

  it('stays hidden for items the Host lists as finished when the page opens, after a reload or a restart', () => {
    const source = createFakeDownloadsSource([item('a', { state: 'ready' }), item('b', { state: 'ready' })])
    render(<Card source={source} />)
    expect(document.querySelector('section')).toBeNull()
    act(() => { source.set([item('a', { state: 'ready' }), item('b', { state: 'ready' }), item('c', { state: 'installing' })]) })
    expect(screen.getByRole('button', { name: /1 left to install/ })).toBeTruthy()
    act(() => { source.set([item('a', { state: 'ready' }), item('b', { state: 'ready' }), item('c', { state: 'ready' })]) })
    expect(screen.getByRole('button', { name: /3 plugins added/ })).toBeTruthy()
    act(() => { vi.advanceTimersByTime(4001) })
    expect(document.querySelector('section')).toBeNull()
  })

  it('keeps a failure open until dismissed, with Retry and Remove', () => {
    const source = createFakeDownloadsSource([item('a', { state: 'failed', failure: { code: 'offline', message: 'No connection.' } }), item('b', { state: 'ready' })])
    render(<Card source={source} />)
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(screen.getByText('1 plugin could not be installed')).toBeTruthy()
    expect(screen.getByText('No connection.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try a again' }))
    expect(source.calls).toEqual(['retry:a'])
    act(() => { source.update('a', { state: 'failed', failure: { code: 'failed', message: 'Broken.' } }) })
    fireEvent.click(screen.getByRole('button', { name: 'Remove a from the list' }))
    expect(source.calls).toEqual(['retry:a', 'remove:a'])
    act(() => { vi.advanceTimersByTime(5000) })
    expect(document.querySelector('section')).toBeNull()
  })

  it('dismisses every failure from the header', () => {
    const source = createFakeDownloadsSource([item('a', { state: 'failed' }), item('b', { state: 'failed' })])
    render(<Card source={source} />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(source.calls).toEqual(['remove:a', 'remove:b'])
  })

  it('announces a new failure once, and never a percentage', () => {
    const source = createFakeDownloadsSource([item('a', { state: 'downloading', receivedBytes: 1, totalBytes: 10 })])
    render(<Card source={source} />)
    expect(screen.getByRole('status').textContent).toBe('')
    for (const received of [2, 5, 9]) act(() => { source.update('a', { receivedBytes: received }) })
    expect(screen.getByRole('status').textContent).toBe('')
    act(() => { source.update('a', { state: 'failed', failure: { code: 'failed', message: 'x' } }) })
    expect(screen.getByRole('status').textContent).toBe('a could not be installed')
  })

  it('does not count earlier additions in the next batch', () => {
    const source = createFakeDownloadsSource([item('a', { state: 'ready' })])
    render(<Card source={source} />)
    act(() => { vi.advanceTimersByTime(5000) })
    act(() => { source.set([item('a', { state: 'ready' }), item('b', { state: 'queued', position: 1 })]) })
    expect(screen.getByRole('button', { name: /1 left to install/ })).toBeTruthy()
  })

  it('moves focus along the buttons in order', () => {
    render(<Card source={createFakeDownloadsSource([item('a', { state: 'downloading', totalBytes: 10 })])} />)
    const buttons = screen.getAllByRole('button')
    buttons[0]?.focus()
    expect(document.activeElement).toBe(buttons[0])
    expect(buttons.map(button => button.getAttribute('aria-label'))).toEqual([expect.stringContaining('1 left to install'), 'Cancel a'])
  })
})

describe('the phone row in the setup guide', () => {
  it('renders nothing for an empty queue', () => {
    const { container } = render(<OnboardingDownloadsRow source={createFakeDownloadsSource()} t={t} />)
    expect(container.querySelector('button')).toBeNull()
  })

  it('is a single muted line with no accent', () => {
    const { container } = render(<OnboardingDownloadsRow source={createFakeDownloadsSource(mixed())} t={t} />)
    expect(screen.getByRole('button', { name: /4 left to install · \d+%/ })).toBeTruthy()
    expect(container.querySelector('[data-tone="quiet"]')).not.toBeNull()
    expect(container.querySelector('[class*="accent"]')).toBeNull()
    expect(container.querySelector('ul')).toBeNull()
  })

  it('expands the list in place, still without accent', () => {
    const { container } = render(<OnboardingDownloadsRow source={createFakeDownloadsSource(mixed())} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: /4 left to install/ }))
    expect(within(container).getAllByRole('listitem').length).toBe(5)
    expect(container.querySelector('[class*="accent"]')).toBeNull()
    expect(container.querySelector('[data-tone="card"]')).toBeNull()
  })

  it('shows a failure as a small neutral marker', () => {
    const { container } = render(<OnboardingDownloadsRow source={createFakeDownloadsSource([item('a', { state: 'failed' }), item('b', { state: 'queued' })])} t={t} />)
    expect(screen.getByRole('img', { name: 'Something could not be installed' })).toBeTruthy()
    expect(container.querySelector('[class*="accent"], [class*="error"], [class*="warn"]')).toBeNull()
  })
})

describe('the header words and the queue wording', () => {
  it('says "Not confirmed" when every unfinished item waits for a confirmation', () => {
    render(<Card source={createFakeDownloadsSource([item('a', { state: 'waiting-for-unlock' }), item('b', { state: 'waiting-for-unlock' }), item('c', { state: 'ready' })])} />)
    expect(screen.getByRole('button', { name: /Not confirmed/ })).toBeTruthy()
    cleanup()
    render(<Card source={createFakeDownloadsSource([item('a', { state: 'waiting-for-unlock' }), item('b', { state: 'downloading' })])} />)
    expect(screen.getByRole('button', { name: /2 left to install/ })).toBeTruthy()
  })

  it('names the place in the queue as next, or by how many are ahead', () => {
    render(<Card source={createFakeDownloadsSource([item('a', { state: 'queued', position: 1 }), item('b', { state: 'queued', position: 2 }), item('c', { state: 'queued', position: 3 })])} />)
    // The status draws its digits apart (Figures), so it is read whole.
    expect([...document.querySelectorAll('[class*="status"]')].map(each => each.textContent)).toEqual(['Waiting · next', 'Waiting · 1 ahead', 'Waiting · 2 ahead'])
  })

  it('counts the badge and the header from the same number', () => {
    const source = createFakeDownloadsSource(mixed())
    const { unmount } = render(<Card source={source} />)
    const header = screen.getByRole('button', { name: /left to install/ }).getAttribute('aria-label') ?? ''
    unmount()
    render(<Sheet source={source} />)
    expect(header).toContain(screen.getByRole('button', { name: /Downloads, \d+ in progress/ }).textContent ?? 'none')
  })
})

describe('the phone header icon and sheet', () => {
  it('is absent when nothing is queued', () => {
    render(<Sheet source={createFakeDownloadsSource()} />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('counts what is unfinished on the badge', () => {
    render(<Sheet source={createFakeDownloadsSource(mixed())} />)
    const icon = screen.getByRole('button', { name: 'Downloads, 4 in progress' })
    expect(icon.textContent).toBe('4')
  })

  it('opens a dialog with the list, closes on Escape and returns focus', () => {
    render(<Sheet source={createFakeDownloadsSource(mixed())} />)
    const icon = screen.getByRole('button', { name: /Downloads, 4/ })
    fireEvent.click(icon)
    const dialog = screen.getByRole('dialog', { name: 'Downloads' })
    expect(within(dialog).getAllByRole('listitem').length).toBe(5)
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Close' }))
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(icon)
  })
})
