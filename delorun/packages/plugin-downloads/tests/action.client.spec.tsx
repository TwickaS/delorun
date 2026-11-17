// @vitest-environment jsdom
/** The Add action a plugin pack gets on the Plugins page: when it replaces the switch, what it does, and what it shows. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { PluginsSubject } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { PackAddAction, packToAdd } from '../src/client/Action.tsx'
import { fallbackTranslate as t } from '../src/client/locales.ts'
import { createFakeDownloadsSource, provideDownloadsSource } from '../src/client/source.ts'

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
    expect(screen.getByRole('status').textContent).toBe('Waiting for unlock')
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
