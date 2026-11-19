// @vitest-environment jsdom
/**
 * The Setup versions section lists the versions with the current one marked, shows what a switch changes in plain
 * words, saves and switches only in the studio at the computer, and says in place what a reach device cannot do.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { HostFetch } from '../src/client/host-api.ts'
import { PROFILE_VERSION_ROUTES, type VersionChanges, type VersionEntry } from '../src/client/versions-api.ts'
import { en, zh } from '../src/client/versions-locales.ts'
import { changeSentences, VersionsSection, type VersionsSectionProps } from '../src/client/VersionsSection.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

type Answer = { status: number; body?: unknown } | 'unreachable'

const ID = (letter: string): string => letter.repeat(40)
const entry = (letter: string, over: Partial<VersionEntry> = {}): VersionEntry =>
  ({ id: ID(letter), at: Date.UTC(2026, 10, 13, 9, 30), summary: `Install @me/alpha-${letter}`, origin: 'other', current: false, ...over })
const NONE: VersionChanges = { plugins: [], bundles: [], exemptions: [], builds: [], patchChanged: false, homePatchChanged: false, lockfileChanged: false, disabled: [], same: true }
const CHANGED: VersionChanges = {
  ...NONE,
  same: false,
  plugins: [{ name: '@me/alpha', to: '1.0.0' }, { name: '@me/beta', from: '2.0.0' }, { name: '@me/gamma', from: '1.0.0', to: '1.1.0' }],
  bundles: [{ name: '@me/bundle', selected: true }, { name: '@me/old', selected: false }],
  patchChanged: true,
  homePatchChanged: true,
  lockfileChanged: true,
  exemptions: [{ axis: 'dsh', key: '@me/alpha@1.0.0', version: '0.2.2', change: 'added' }, { axis: 'delorun', key: '@me/x@1', version: '1', change: 'removed' }],
  builds: [{ key: 'native', from: 'pending', to: true }, { key: 'other', to: false }, { key: 'third', from: true }],
  disabled: [{ name: '@me/revoked', message: 'revoked for a leak' }],
}

/** A fake home answering each route key with the next scripted answer, the last repeating. */
function fakeHost(script: Record<string, Answer | Answer[]>) {
  const received: { key: string; body: unknown }[] = []
  const fetch: HostFetch = async (input, init) => {
    const key = `${init?.method === 'POST' ? 'POST' : 'GET'} ${input.split('?')[0]!}`
    received.push({ key, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined })
    const entry = script[key] ?? { status: 404, body: { error: 'NOT_FOUND', message: 'No such route' } }
    const answer = Array.isArray(entry) ? (entry.length > 1 ? entry.shift() : entry[0]) : entry
    if (answer === undefined || answer === 'unreachable') throw new TypeError('Failed to fetch')
    return new Response(JSON.stringify(answer.body), { status: answer.status })
  }
  return { fetch, received, count: (key: string) => received.filter(request => request.key === key).length }
}

const LIST = `GET ${PROFILE_VERSION_ROUTES.list}`
const CHANGES = `GET ${PROFILE_VERSION_ROUTES.changes}`
const SAVE = `POST ${PROFILE_VERSION_ROUTES.save}`
const SWITCH = `POST ${PROFILE_VERSION_ROUTES.switch}`
const listing = (versions: VersionEntry[], extra: object = {}) => ({ status: 200, body: { versions, unsaved: false, ...extra } })
const refusal = (status: number, error: string, message = `${error} sentence`) => ({ status, body: { error, message } })

function renderSection(host: ReturnType<typeof fakeHost>, atComputer = true, dictionary: typeof en = en) {
  const props = { t: makeTranslate(dictionary), close: () => {}, fetch: host.fetch, atComputer: () => atComputer } as VersionsSectionProps
  return render(<VersionsSection {...props} />)
}


describe('the Setup versions section', () => {
  it('shows the empty state with Save this setup', async () => {
    renderSection(fakeHost({ [LIST]: listing([]) }))
    expect(await screen.findByText(en.empty)).toBeTruthy()
    expect(screen.getByRole('button', { name: en['save.action'] })).toBeTruthy()
  })

  it('lists many versions newest first, names what made each, and marks the current one', async () => {
    const versions = [
      entry('a', { origin: 'switch', summary: 'Before switching to Work' }),
      entry('b', { origin: 'saved', name: 'Work', current: true }),
      entry('c', { origin: 'update', summary: 'Before update to Delorun 1.0.1' }),
      entry('d', { origin: 'saved' }),
      ...Array.from({ length: 30 }, (_, index) => entry(String(index % 10), { id: `${String(index).padStart(2, '0')}${'e'.repeat(38)}` })),
    ]
    const { container } = renderSection(fakeHost({ [LIST]: listing(versions) }))
    await screen.findByText('Work')
    const rows = [...container.querySelectorAll('li[data-version]')]
    expect(rows).toHaveLength(34)
    expect(rows[0]!.textContent).toContain('Before switching to Work')
    expect(rows[0]!.textContent).toContain(en['origin.switch'])
    expect(rows[1]!.getAttribute('data-current')).toBe('true')
    expect(within(rows[1] as HTMLElement).getByText(en.current)).toBeTruthy()
    expect(within(rows[1] as HTMLElement).queryByRole('button', { name: en['switch.action'] })).toBeNull()
    expect(rows[2]!.textContent).toContain(en['origin.update'])
    expect(rows[3]!.textContent).toContain(en['version.saved'])
    expect(rows.filter(row => row.getAttribute('data-current') === 'true')).toHaveLength(1)
  })

  it('says when the setup has changes no version holds', async () => {
    renderSection(fakeHost({ [LIST]: listing([entry('a')], { unsaved: true }) }))
    expect(await screen.findByText(en.unsaved)).toBeTruthy()
  })

  it('shows what a switch changes in plain words, or that nothing changes', async () => {
    const host = fakeHost({ [LIST]: listing([entry('a'), entry('b')]), [CHANGES]: [{ status: 200, body: { changes: CHANGED } }, { status: 200, body: { changes: NONE } }] })
    const { container } = renderSection(host)
    await screen.findAllByRole('button', { name: en['changes.show'] })
    const [first, second] = [...container.querySelectorAll<HTMLElement>('li[data-version]')]
    fireEvent.click(within(first!).getByRole('button', { name: en['changes.show'] }))
    await within(first!).findByText(en['changes.intro'])
    for (const text of [
      '@me/alpha comes back at 1.0.0.', '@me/beta is removed (now 2.0.0).', '@me/gamma goes from 1.0.0 to 1.1.0.',
      'The bundle @me/bundle is added to your bundle list.', 'The bundle @me/old leaves your bundle list.',
      en['change.patch'], en['change.homePatch'], en['change.lockfile'],
      'The version exemption for @me/alpha@1.0.0 on the dsh axis is added.', 'The version exemption for @me/x@1 on the delorun axis is removed.',
      'The build script of native goes from undecided to allowed.', 'The build script of other goes from unset to denied.', 'The build script of third goes from allowed to unset.',
      '@me/revoked comes back turned off: revoked for a leak',
    ]) expect(within(first!).getByText(text)).toBeTruthy()
    fireEvent.click(within(first!).getByRole('button', { name: en['changes.hide'] }))
    expect(within(first!).queryByText(en['changes.intro'])).toBeNull()
    fireEvent.click(within(second!).getByRole('button', { name: en['changes.show'] }))
    expect(await within(second!).findByText(en['changes.same'])).toBeTruthy()
  })

  it('shows the failure of a comparison in place', async () => {
    renderSection(fakeHost({ [LIST]: listing([entry('a')]), [CHANGES]: refusal(404, 'UNKNOWN_VERSION', 'That version is not in this profile\'s history.') }))
    fireEvent.click(await screen.findByRole('button', { name: en['changes.show'] }))
    expect((await screen.findByRole('alert')).textContent).toBe('That version is not in this profile\'s history.')
  })

  it('saves the setup with its name and lists the new version', async () => {
    const host = fakeHost({
      [LIST]: [listing([entry('a')]), listing([entry('f', { origin: 'saved', name: 'Before beta', current: true }), entry('a')])],
      [SAVE]: { status: 200, body: { id: ID('f'), created: true } },
    })
    renderSection(host)
    await screen.findByText(en['save.name'])
    fireEvent.change(screen.getByLabelText(en['save.name']), { target: { value: 'Before beta' } })
    fireEvent.click(screen.getByRole('button', { name: en['save.action'] }))
    expect(await screen.findByText(en['save.saved'])).toBeTruthy()
    expect(host.received.find(request => request.key === SAVE)?.body).toEqual({ name: 'Before beta' })
    expect(await screen.findByText('Before beta')).toBeTruthy()
  })

  it('says a save of an unchanged setup made no new version', async () => {
    renderSection(fakeHost({ [LIST]: listing([entry('a', { current: true })]), [SAVE]: { status: 200, body: { id: ID('a'), created: false } } }))
    fireEvent.click(await screen.findByRole('button', { name: en['save.action'] }))
    expect(await screen.findByText(en['save.unchanged'])).toBeTruthy()
  })

  it('switches, shows the version that was saved and that a restart is needed, and offers switching back', async () => {
    const host = fakeHost({
      [LIST]: [listing([entry('a', { current: true }), entry('b')]), listing([entry('s', { origin: 'switch', summary: 'Before switching to Old' }), entry('a'), entry('b', { current: true })])],
      [SWITCH]: { status: 200, body: { saved: ID('s'), changes: CHANGED, restartNeeded: true } },
    })
    const { container } = renderSection(host)
    await screen.findAllByRole('button', { name: en['switch.action'] })
    fireEvent.click(screen.getByRole('button', { name: en['switch.action'] }))
    expect((await screen.findByRole('status')).textContent).toBe(en['switch.done'])
    expect(host.received.find(request => request.key === SWITCH)?.body).toEqual({ version: ID('b') })
    await waitFor(() => { expect(container.querySelectorAll('li[data-version]')).toHaveLength(3) })
    expect(container.querySelector('li[data-version]')!.textContent).toContain('Before switching to Old')
  })

  it('says nothing needs a restart when the setup already matched', async () => {
    renderSection(fakeHost({
      [LIST]: listing([entry('a', { current: true }), entry('b')]),
      [SWITCH]: { status: 200, body: { changes: NONE, restartNeeded: false } },
    }))
    fireEvent.click(await screen.findByRole('button', { name: en['switch.action'] }))
    expect((await screen.findByRole('status')).textContent).toBe(en['switch.doneSame'])
  })

  it('shows a refused switch in place and keeps the list', async () => {
    renderSection(fakeHost({ [LIST]: listing([entry('a', { current: true }), entry('b')]), [SWITCH]: refusal(422, 'SWITCH_REFUSED', 'a settings file holds a secret value') }))
    fireEvent.click(await screen.findByRole('button', { name: en['switch.action'] }))
    expect((await screen.findByRole('alert')).textContent).toBe('a settings file holds a secret value')
    expect(screen.getByRole('button', { name: en['switch.action'] })).toBeTruthy()
  })

  it('disables the button while a switch runs', async () => {
    let finish: (response: Response) => void = () => {}
    const base = fakeHost({ [LIST]: listing([entry('a', { current: true }), entry('b')]) })
    const fetch: HostFetch = (input, init) => input === PROFILE_VERSION_ROUTES.switch ? new Promise<Response>((resolve) => { finish = resolve }) : base.fetch(input, init)
    render(<VersionsSection {...{ t: makeTranslate(en), close: () => {}, fetch, atComputer: () => true } as VersionsSectionProps} />)
    fireEvent.click(await screen.findByRole('button', { name: en['switch.action'] }))
    expect((await screen.findByRole('button', { name: en['switch.busy'] }) as HTMLButtonElement).disabled).toBe(true)
    finish(new Response(JSON.stringify({ changes: NONE, restartNeeded: false }), { status: 200 }))
    expect(await screen.findByRole('status')).toBeTruthy()
  })

  it('turns the home\'s computer-only refusal into one sentence', async () => {
    renderSection(fakeHost({ [LIST]: listing([entry('a', { current: true }), entry('b')]), [SWITCH]: refusal(403, 'LOOPBACK_REQUIRED') }))
    fireEvent.click(await screen.findByRole('button', { name: en['switch.action'] }))
    expect((await screen.findByRole('alert')).textContent).toBe(en.loopback)
  })

  it('offers a reach device the list, the differences, save and switch, and names setup files as done at the computer with the reason', async () => {
    const host = fakeHost({ [LIST]: listing([entry('a', { current: true }), entry('b')]), [CHANGES]: { status: 200, body: { changes: CHANGED } } })
    renderSection(host, false)
    expect(await screen.findByText(en['gate.computer'].replace('{reason}', en.transferReason))).toBeTruthy()
    expect(screen.getByRole('button', { name: en['save.action'] })).toBeTruthy()
    expect(screen.getByRole('button', { name: en['switch.action'] })).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: en['changes.show'] })[1]!)
    expect(await screen.findByText(en['changes.intro'])).toBeTruthy()
  })

  it('says each save or switch asks for Face ID or the PIN, without an Unlock button, and keeps the version list', async () => {
    renderSection(fakeHost({
      [LIST]: listing([entry('a', { current: true }), entry('b')]),
      [SWITCH]: refusal(403, 'ELEVATION_REQUIRED'),
      [SAVE]: refusal(403, 'ELEVATION_REQUIRED'),
    }), false)
    fireEvent.click(await screen.findByRole('button', { name: en['switch.action'] }))
    expect(await screen.findByText(en['gate.face'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['save.action'] }))
    await waitFor(() => { expect(screen.getAllByText(en['gate.face'])).toHaveLength(2) })
    expect(screen.queryByRole('button', { name: /unlock/i })).toBeNull()
    expect(screen.getAllByRole('listitem').length).toBeGreaterThan(0)
  })

  it('shows the failure of reading the list, and the history problem the home reports', async () => {
    const { unmount } = renderSection(fakeHost({ [LIST]: 'unreachable' }))
    expect((await screen.findByRole('alert')).textContent).toBe(en['failed.unreachable'])
    unmount()
    renderSection(fakeHost({ [LIST]: listing([], { problem: 'The version history could not be read.' }) }))
    expect((await screen.findByRole('alert')).textContent).toBe('The version history could not be read.')
  })

  it('shows an unreadable answer as one sentence', async () => {
    renderSection(fakeHost({ [LIST]: { status: 200, body: { versions: 'nope' } } }))
    expect((await screen.findByRole('alert')).textContent).toBe(en['failed.unreadable'])
  })

  it('has a Chinese entry for every English one, with the same placeholders', () => {
    expect(Object.keys(zh).toSorted()).toEqual(Object.keys(en).toSorted())
    const holes = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]!).toSorted()
    for (const key of Object.keys(en) as (keyof typeof en)[]) expect(holes(zh[key])).toEqual(holes(en[key]))
  })

  it('writes no sentences for an unchanged comparison', () => {
    expect(changeSentences(makeTranslate(en) as never, NONE)).toEqual([])
  })
})
