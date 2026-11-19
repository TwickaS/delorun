// @vitest-environment jsdom
/** The Add action a plugin pack gets on the Plugins page: when it replaces the switch, what it does, and what it shows. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { PluginsSubject } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { PackAddAction, PackNotLoadingAction, packNotLoading, packToAdd } from '../src/client/Action.tsx'
import { fallbackTranslate as t } from '../src/client/locales.ts'
import { createFakeDownloadsSource, provideDownloadsSource, provideUninstall } from '../src/client/source.ts'

const bundle = (name: string, patch: Partial<Extract<PluginsSubject, { kind: 'bundle' }>['pkg']> = {}): PluginsSubject => ({
  kind: 'bundle', pkg: { name, installed: false, availability: 'missing', official: true, enabled: false, rows: [], ...patch },
})
const BROWSER = '@delorun/bundle-browser'

afterEach(() => { cleanup() })

describe('which subjects get the Add action', () => {
  it('takes a pack of the release that is not in the home, and leaves the switch for everything else', () => {
    expect(packToAdd(bundle(BROWSER))).toBe(BROWSER)
    expect(packToAdd(bundle(BROWSER, { installed: true }))).toBeNull()
    expect(packToAdd(bundle(BROWSER, { availability: 'profile' }))).toBeNull()
    expect(packToAdd(bundle('some-other-bundle'))).toBeNull()
    expect(packToAdd(bundle('toString'))).toBeNull()
    expect(packToAdd({ kind: 'item', id: BROWSER })).toBeNull()
    expect(packToAdd({ kind: 'row', pkg: { name: BROWSER, installed: false, availability: 'missing', official: true, enabled: false, rows: [] }, row: { rowId: 'x', moduleName: 'x', enabled: false } })).toBeNull()
  })
})

describe('the Add action', () => {
  it('adds the pack to the install list when pressed, then shows where it stands', () => {
    const source = createFakeDownloadsSource()
    const release = provideDownloadsSource(source)
    render(<PackAddAction matched={BROWSER} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add Browser' }))
    expect(source.calls).toEqual([`enqueue:${BROWSER}`])
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('Waiting')
    act(() => { source.update(BROWSER, { state: 'verifying' }) })
    expect(screen.getByRole('status').textContent).toBe('Checking')
    act(() => { source.update(BROWSER, { state: 'ready' }) })
    expect(screen.getByRole('status').textContent).toBe('Added')
    release()
  })

  it('shows a phone that awaits the unlock, and a failure with Try again', () => {
    const source = createFakeDownloadsSource([{ key: BROWSER, state: 'waiting-for-unlock', receivedBytes: 0 }])
    const release = provideDownloadsSource(source)
    render(<PackAddAction matched={BROWSER} t={t} />)
    expect(screen.getByRole('status').textContent).toBe('Not confirmed. Try again to confirm with Face ID or your PIN')
    act(() => { source.update(BROWSER, { state: 'failed', failure: { code: 'offline', message: 'No connection.' } }) })
    expect(screen.getByRole('status').textContent).toContain('No connection.')
    fireEvent.click(screen.getByRole('button', { name: 'Try Browser again' }))
    expect(source.calls).toEqual([`retry:${BROWSER}`])
    release()
  })

  it('offers Add again after a cancelled install', () => {
    const source = createFakeDownloadsSource([{ key: BROWSER, state: 'cancelled', receivedBytes: 0 }])
    const release = provideDownloadsSource(source)
    render(<PackAddAction matched={BROWSER} t={t} />)
    expect(screen.getByRole('button', { name: 'Add Browser' })).toBeTruthy()
    release()
  })
})

describe('an installed pack whose last install failed', () => {
  const failed = { key: BROWSER, state: 'failed' as const, receivedBytes: 0, failure: { code: 'failed' as const, message: 'The plugin manager could not load @delorun/bundle-browser (operation-error).' } }

  it('takes the place of the switch only while the queue holds the failure, and only for an installed pack of the release', () => {
    const source = createFakeDownloadsSource([failed])
    const release = provideDownloadsSource(source)
    expect(packNotLoading(bundle(BROWSER, { installed: true, availability: 'profile' }))).toBe(BROWSER)
    expect(packNotLoading(bundle(BROWSER))).toBeNull()
    expect(packNotLoading(bundle('some-other-bundle', { installed: true }))).toBeNull()
    expect(packNotLoading({ kind: 'item', id: BROWSER })).toBeNull()
    act(() => { source.update(BROWSER, { state: 'ready' }) })
    expect(packNotLoading(bundle(BROWSER, { installed: true, availability: 'profile' }))).toBeNull()
    release()
  })

  it('says it is installed but not loading, with the reason, and Try again starts it again', () => {
    const source = createFakeDownloadsSource([failed])
    const release = provideDownloadsSource(source)
    render(<PackNotLoadingAction matched={BROWSER} t={t} />)
    expect(screen.getByRole('status').textContent).toContain('Installed, but not loading: The plugin manager could not load')
    fireEvent.click(screen.getByRole('button', { name: 'Try Browser again' }))
    expect(source.calls).toEqual([`retry:${BROWSER}`])
    // Until the page draws again the action shows where the retry stands, never a blank.
    expect(screen.getByRole('status').textContent).toBe('Waiting')
    release()
  })

  it('removes the pack through the plugin manager first, and only then clears the failed record', async () => {
    const source = createFakeDownloadsSource([failed])
    const release = provideDownloadsSource(source)
    const uninstalled: string[] = []
    const unprovide = provideUninstall((name) => { uninstalled.push(name); return Promise.resolve() })
    render(<PackNotLoadingAction matched={BROWSER} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove Browser' }))
    await act(async () => { await Promise.resolve() })
    expect(uninstalled).toEqual([BROWSER])
    expect(source.calls).toEqual([`remove:${BROWSER}`])
    unprovide()
    release()
  })

  it('keeps the failed record and says so when the removal does not happen, as when it is refused', async () => {
    const source = createFakeDownloadsSource([failed])
    const release = provideDownloadsSource(source)
    const unprovide = provideUninstall(() => Promise.reject(new Error('refused')))
    render(<PackNotLoadingAction matched={BROWSER} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove Browser' }))
    await act(async () => { await Promise.resolve() })
    expect(source.calls).toEqual([])
    expect(screen.getByRole('status').textContent).toContain('It could not be removed.')
    unprovide()
    release()
  })
})
