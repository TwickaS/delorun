// @vitest-environment jsdom
/** The studio half: the store's one read, `usePreviewFlag` under its provider, and the chip with its tooltip. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { createPreviewFlagsStore, en, PREVIEW_FLAG_ROUTES, PreviewChip, PreviewFlagsProvider, previewFlagId, usePreviewFlag, zh, type PreviewFlagsFetch, type PreviewFlagView } from '../src/client/index.ts'

afterEach(cleanup)

const STEPS = previewFlagId('onboarding.previewSteps')
const OTHER = previewFlagId('browser.ownChrome')
const view = (on: boolean): PreviewFlagView => ({ id: STEPS, kind: 'boolean', owner: '@test/plugin-onboarding', title: { en: 'Planned steps', zh: '计划中的步骤' }, description: { en: 'd', zh: 'd' }, on })

/** A Host answering the read route with scripted answers, one per request. */
function host(...answers: Array<readonly PreviewFlagView[] | number | 'garbage'>): { readonly fetch: PreviewFlagsFetch; readonly urls: string[] } {
  const urls: string[] = []
  const queue = [...answers]
  return {
    urls,
    fetch: async (input) => {
      urls.push(input)
      const next = queue.length > 1 ? queue.shift()! : queue[0]!
      if (typeof next === 'number') return new Response('{}', { status: next })
      return new Response(JSON.stringify(next === 'garbage' ? { flags: [{ id: 'x' }] } : { flags: next }), { status: 200 })
    },
  }
}

function Reads({ id }: { readonly id: typeof STEPS }): ReactNode {
  return <output data-testid={id}>{usePreviewFlag(id) ? 'on' : 'off'}</output>
}

describe('usePreviewFlag', () => {
  it('reads off until the Host answers, then the flag\'s state, with one request for every reader', async () => {
    const { fetch, urls } = host([view(true)])
    const store = createPreviewFlagsStore(fetch)
    render(<PreviewFlagsProvider store={store}><Reads id={STEPS} /><Reads id={OTHER} /><Reads id={STEPS} /></PreviewFlagsProvider>)
    expect(screen.getAllByTestId(STEPS).map(node => node.textContent)).toEqual(['off', 'off'])
    await waitFor(() => { expect(screen.getAllByTestId(STEPS).map(node => node.textContent)).toEqual(['on', 'on']) })
    // A flag the Host does not declare, such as one whose plugin is off, reads off.
    expect(screen.getByTestId(OTHER).textContent).toBe('off')
    expect(urls).toEqual([PREVIEW_FLAG_ROUTES.list.slice(1)])
  })

  it('reads off for a flag the profile leaves off', async () => {
    const store = createPreviewFlagsStore(host([view(false)]).fetch)
    render(<PreviewFlagsProvider store={store}><Reads id={STEPS} /></PreviewFlagsProvider>)
    await waitFor(() => { expect(store.getSnapshot().status).toBe('ready') })
    expect(screen.getByTestId(STEPS).textContent).toBe('off')
  })

  it.each<readonly [string, number | 'garbage']>([['a profile without the row (404)', 404], ['an answer that is not the route\'s JSON', 'garbage']])('reads off for %s and says so once in the console', async (_, answer) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createPreviewFlagsStore(host(answer).fetch)
    render(<PreviewFlagsProvider store={store}><Reads id={STEPS} /></PreviewFlagsProvider>)
    await waitFor(() => { expect(store.getSnapshot().status).toBe('failed') })
    expect(screen.getByTestId(STEPS).textContent).toBe('off')
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('reads again only when asked', async () => {
    const { fetch, urls } = host([view(false)], [view(true)])
    const store = createPreviewFlagsStore(fetch)
    render(<PreviewFlagsProvider store={store}><Reads id={STEPS} /></PreviewFlagsProvider>)
    await waitFor(() => { expect(store.getSnapshot().status).toBe('ready') })
    await act(async () => { await store.load() })
    expect(urls).toHaveLength(1)
    await act(async () => { await store.refresh() })
    expect(screen.getByTestId(STEPS).textContent).toBe('on')
    expect(urls).toHaveLength(2)
  })

  it('fails without a provider, naming the flag', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Reads id={STEPS} />)).toThrow('usePreviewFlag("onboarding.previewSteps") needs a PreviewFlagsProvider above it')
    error.mockRestore()
  })
})

describe('the preview chip', () => {
  const t = (key: keyof typeof en): string => en[key]

  it('reads "Preview", takes keyboard focus and explains itself in a tooltip', async () => {
    render(<PreviewChip t={t} />)
    const chip = screen.getByText('Preview')
    expect(chip.tabIndex).toBe(0)
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.focus(chip)
    expect((await screen.findByRole('tooltip')).textContent).toBe(en['previewFlag.tooltip'])
    fireEvent.blur(chip)
    await waitFor(() => { expect(screen.queryByRole('tooltip')).toBeNull() })
  })

  it('shows the feature\'s own sentence when it is given one', async () => {
    render(<PreviewChip t={t} tooltip="Choosing this records nothing." />)
    fireEvent.focus(screen.getByText('Preview'))
    expect((await screen.findByRole('tooltip')).textContent).toBe('Choosing this records nothing.')
  })

  it('has both languages for every key', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    for (const value of [...Object.values(en), ...Object.values(zh)]) expect(value.trim()).not.toBe('')
  })

})
