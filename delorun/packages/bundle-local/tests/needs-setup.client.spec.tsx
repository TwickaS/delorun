// @vitest-environment jsdom
/** The "Needs setup" state in Plugins: a row's reason with its fix, nothing for a met row, and a bundle's broken declaration. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { NeedsSetup, type NeedsSetupProps } from '../src/client/NeedsSetup.tsx'
import { REQUIREMENT_ROUTES, type RequirementRow, type RequirementsAnswer } from '../src/client/requirements-api.ts'
import { en, zh } from '../src/client/requirements-locales.ts'
import { RequirementsStore } from '../src/client/requirements-store.ts'
import type { HostFetch } from '../src/client/host-api.ts'

afterEach(cleanup)

const PKG = { name: '@test/bundle', installed: true, availability: 'profile', official: false, enabled: true, rows: [] } as const
const ROW = { rowId: 'row', moduleName: 'm', enabled: true }
const needs = (fix: RequirementRow & { state: 'needs-setup' } extends infer R ? R extends { fix: infer F } ? F : never : never): RequirementsAnswer => ({
  rows: [{ packageName: PKG.name, rowId: 'row', state: 'needs-setup', reason: 'Needs Chrome installed', fix }], problems: [],
})

/** A Host answering the check with scripted answers, one per request. */
function host(...answers: Array<RequirementsAnswer | 'down'>): { fetch: HostFetch, urls: string[] } {
  const urls: string[] = []
  const queue = [...answers]
  const fetch: HostFetch = async (input) => {
    urls.push(input)
    const next = queue.length > 1 ? queue.shift()! : queue[0]!
    if (next === 'down') return new Response('{}', { status: 500 })
    return new Response(JSON.stringify(next), { status: 200 })
  }
  return { fetch, urls }
}

function show(fetch: HostFetch, subject: NeedsSetupProps['subject'], extra: { openSettings?: (s: string) => void, copy?: (t: string) => Promise<void> } = {}) {
  const store = new RequirementsStore(fetch, () => 'en')
  const props = { t: makeTranslate(en), subject, store, openSettings: extra.openSettings ?? vi.fn(), copy: extra.copy ?? (async () => {}) } as unknown as NeedsSetupProps
  return { store, ...render(<NeedsSetup {...props} />) }
}

const row = { kind: 'row', pkg: PKG, row: ROW } as const

describe('the Needs setup state', () => {
  it('reads "Needs setup · reason" with a docs link', async () => {
    const { fetch, urls } = host(needs({ kind: 'docs', url: 'https://example.com/chrome', label: 'Get Chrome' }))
    render(<></>)
    show(fetch, row)
    expect(await screen.findByText('Needs setup · Needs Chrome installed')).toBeTruthy()
    expect(urls[0]).toBe(`${REQUIREMENT_ROUTES.check}?language=en`)
    const link = screen.getByRole('link', { name: 'Get Chrome' })
    expect(link.getAttribute('href')).toBe('https://example.com/chrome')
    expect(link.getAttribute('rel')).toContain('noopener')
  })

  it('shows a command with a copy button that copies exactly that command', async () => {
    const copy = vi.fn(async () => {})
    show(host(needs({ kind: 'command', command: 'npm i -g tool' })).fetch, row, { copy })
    expect((await screen.findByText('npm i -g tool')).tagName).toBe('CODE')
    fireEvent.click(screen.getByRole('button', { name: 'Copy the command: npm i -g tool' }))
    expect(copy).toHaveBeenCalledWith('npm i -g tool')
    expect(await screen.findByText('Copied')).toBeTruthy()
  })

  it('opens the named settings section', async () => {
    const openSettings = vi.fn()
    show(host(needs({ kind: 'settings', section: 'delorun-network' })).fetch, row, { openSettings })
    fireEvent.click(await screen.findByRole('button', { name: 'Open settings' }))
    expect(openSettings).toHaveBeenCalledWith('delorun-network')
  })

  it('draws nothing for a ready row, an undeclared row, a bundle without a problem or an item', async () => {
    const answer: RequirementsAnswer = { rows: [{ packageName: PKG.name, rowId: 'row', state: 'ready' }], problems: [] }
    const { fetch, urls } = host(answer)
    const a = show(fetch, row)
    const b = show(fetch, { kind: 'row', pkg: PKG, row: { ...ROW, rowId: 'other' } })
    const c = show(fetch, { kind: 'bundle', pkg: PKG })
    const d = show(fetch, { kind: 'item', id: 'x' })
    await waitFor(() => { expect(urls.length).toBeGreaterThan(0) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    for (const view of [a, b, c, d]) expect(view.container.innerHTML).toBe('')
  })

  it('clears when the next read says the need is met', async () => {
    const ready: RequirementsAnswer = { rows: [{ packageName: PKG.name, rowId: 'row', state: 'ready' }], problems: [] }
    const { fetch } = host(needs({ kind: 'docs', url: 'https://example.com' }), ready)
    const { store, container } = show(fetch, row)
    await screen.findByText(/Needs setup/)
    await act(async () => { await store.refresh() })
    expect(container.innerHTML).toBe('')
  })

  it('re-reads when the window regains focus', async () => {
    const { fetch, urls } = host(needs({ kind: 'docs', url: 'https://example.com' }))
    show(fetch, row)
    await screen.findByText(/Needs setup/)
    const before = urls.length
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => { expect(urls.length).toBeGreaterThan(before) })
  })

  it('shares one request between overlapping reads', async () => {
    const { fetch, urls } = host(needs({ kind: 'docs', url: 'https://example.com' }))
    const store = new RequirementsStore(fetch, () => 'en')
    await Promise.all([store.refresh(), store.refresh(), store.refresh()])
    expect(urls).toHaveLength(1)
  })

  it('names a bundle whose declaration the Host could not read, and a check that failed', async () => {
    const broken: RequirementsAnswer = { rows: [], problems: [{ packageName: PKG.name, message: 'locale/en.json has no reason' }] }
    const first = show(host(broken).fetch, { kind: 'bundle', pkg: PKG })
    expect((await screen.findByRole('alert')).textContent).toBe(`Could not read what ${PKG.name} needs: locale/en.json has no reason`)
    first.unmount()
    show(host('down').fetch, { kind: 'bundle', pkg: PKG })
    expect((await screen.findByRole('alert')).textContent).toBe(en.checkFailed)
  })

  it('keeps the last answer when a later read fails', async () => {
    const { fetch } = host(needs({ kind: 'docs', url: 'https://example.com' }), 'down')
    const { store } = show(fetch, row)
    await screen.findByText(/Needs setup/)
    await act(async () => { await store.refresh() })
    expect(screen.getByText(/Needs setup/)).toBeTruthy()
    expect(store.getSnapshot().failed).toBe(true)
  })

  it('has Chinese copy for every key', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    expect(zh.state).toContain('{reason}')
  })
})
