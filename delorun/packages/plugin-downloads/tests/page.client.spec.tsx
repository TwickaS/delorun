// @vitest-environment jsdom
/**
 * Downloads the page runs itself, outside the Host's install queue: they join every downloads surface after the Host's
 * items, draw a bar without a measure until bytes have a size, cannot be cancelled, and leave the list as their starter
 * says.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ItemList } from '../src/client/Items.tsx'
import { fallbackTranslate as t } from '../src/client/locales.ts'
import { createFakeDownloadsSource, currentDownloadsSource, provideDownloadsSource, startPageDownload } from '../src/client/source.ts'

/** The list over the provided source, as the surfaces read it. */
function List() {
  const source = currentDownloadsSource()
  const items = useSyncExternalStore(source.subscribe, source.snapshot)
  return <ItemList items={items} source={source} t={t} tone="card" label="Plugins" />
}

const withdrawals: Array<() => void> = []
afterEach(() => {
  cleanup()
  for (const withdraw of withdrawals.splice(0)) withdraw()
  for (const item of currentDownloadsSource().snapshot()) currentDownloadsSource().remove(item.key)
})

describe('a download the page runs itself', () => {
  it('follows the Host\'s items, and a Host item of the same name wins', () => {
    const host = createFakeDownloadsSource([{ key: 'pack', state: 'downloading', receivedBytes: 1, totalBytes: 2 }])
    withdrawals.push(provideDownloadsSource(host))
    startPageDownload('@scope/a', { title: 'A' })
    startPageDownload('pack')
    expect(currentDownloadsSource().snapshot().map(item => [item.key, item.local === undefined ? 'host' : 'page'])).toEqual([['pack', 'host'], ['@scope/a', 'page']])
  })

  it('draws a bar without a measure, says it downloads, and offers no Cancel', () => {
    startPageDownload('@scope/a', { title: 'A' })
    render(<List />)
    const bar = screen.getByRole('progressbar', { name: 'A' })
    expect(bar.hasAttribute('aria-valuenow')).toBe(false)
    expect(bar.hasAttribute('data-unmeasured')).toBe(true)
    expect(screen.getByText('Downloading')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Cancel A' })).toBeNull()
  })

  it('measures the bar once bytes come with a size, then ends as added or needing a reload', () => {
    const shown = startPageDownload('@scope/a', { title: 'A' })
    render(<List />)
    act(() => { shown.bytes(5, 20) })
    expect(screen.getByRole('progressbar', { name: 'A' }).getAttribute('aria-valuenow')).toBe('25')
    act(() => { shown.done() })
    expect(screen.getByText('Added')).toBeTruthy()
    act(() => { startPageDownload('@scope/b', { title: 'B' }).done(true) })
    expect(screen.getByText('Added, reload to use it')).toBeTruthy()
  })

  it('offers Try again on a failure only when its starter can start it again, and Remove takes it off', () => {
    const retry = vi.fn()
    startPageDownload('@scope/a', { title: 'A', retry }).failed('The registry refused it')
    startPageDownload('@scope/b', { title: 'B' }).failed()
    render(<List />)
    expect(screen.getByText('The registry refused it')).toBeTruthy()
    expect(screen.getByText('Not installed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try A again' }))
    expect(retry).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Try B again' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Remove B from the list' }))
    expect(screen.queryByText('B')).toBeNull()
  })

  it('starts as installing for a change that downloads nothing', () => {
    startPageDownload('@scope/a', { title: 'A', state: 'installing' })
    render(<List />)
    expect(screen.getByText('Installing')).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: 'A' }).hasAttribute('data-unmeasured')).toBe(false)
  })

  it('belongs to its latest start: an earlier start of the same name changes nothing', () => {
    const first = startPageDownload('@scope/a')
    const second = startPageDownload('@scope/a')
    first.failed('old')
    expect(currentDownloadsSource().snapshot().find(item => item.key === '@scope/a')?.state).toBe('downloading')
    second.done()
    expect(currentDownloadsSource().snapshot().find(item => item.key === '@scope/a')?.state).toBe('ready')
  })
})
