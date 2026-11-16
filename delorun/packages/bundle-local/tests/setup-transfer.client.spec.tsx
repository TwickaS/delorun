// @vitest-environment jsdom
/**
 * Move your setup, in the Setup versions section: Export setup hands the home's file to the browser; Import setup sends a
 * chosen file for checking, shows who signed it and everything that would change, and replaces the setup only after the
 * second click. A reach device is offered neither button, and a refusal is shown in place.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SETUP_PATHS, type SetupApplyView, type SetupExportView, type SetupInspectView } from '@delorun/plugin-changes/wire'
import type { HostFetch } from '../src/client/host-api.ts'
import { fromBase64, toBase64 } from '../src/client/setup-transfer-api.ts'
import { PROFILE_VERSION_ROUTES } from '../src/client/versions-api.ts'
import { en, zh } from '../src/client/versions-locales.ts'
import { VersionsSection, type VersionsSectionProps } from '../src/client/VersionsSection.tsx'

afterEach(() => {
  cleanup()
})

const EXPORTED: SetupExportView = { file: toBase64(new Uint8Array([1, 2, 3])), name: 'setup.delorun', plugins: 2, local: 1, settings: 3, leftOut: ['sandbox-policy: belongs to this computer'], signedBy: 'KEY123' }
const INSPECTED: SetupInspectView = {
  token: 'tok', signer: { state: 'unverified', reason: 'key-not-trusted', fingerprint: 'FP-OTHER' }, createdBy: '0.1.0', exportedAt: '2026-11-16T10:00:00Z', sourceProfile: 'default',
  install: [{ name: 'plug', version: '1.0.0', kind: 'add', source: 'local' }, { name: 'left-pad', version: '1.3.0', kind: 'replace', source: 'registry', from: 'version 1.2.0' }],
  remove: ['old-plugin'], keep: [], settings: ['changed: llm-deepseek'], endpoints: ['providers.x.baseURL sends requests to https://m.example.com/v1'], leftOut: ['sandbox-policy: belongs to this computer'],
  keyNotes: ['The default model is deepseek-official / v4. Add its key.'], protection: 'on', changes: true,
}
const APPLIED: SetupApplyView = { savedVersion: 'v'.repeat(40), removed: ['old-plugin'], installed: [{ name: 'plug', reviewChange: 'c0123456789' }, { name: 'left-pad' }], settingsWritten: true, keyNotes: ['The default model is deepseek-official / v4. Add its key.'], protection: 'on' }

type Answer = { status: number; body?: unknown }

/**
 * A home answering each route with a scripted answer and recording the bodies it received.
 * @param script - the answers by `METHOD path`.
 * @returns the request function and what it received.
 */
function host(script: Record<string, Answer>) {
  const received: { key: string; body: unknown }[] = []
  const fetch: HostFetch = async (input, init) => {
    const key = `${init?.method === 'POST' ? 'POST' : 'GET'} ${input.split('?')[0]!}`
    received.push({ key, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined })
    const answer = script[key] ?? { status: 404, body: { error: 'NOT_FOUND', message: 'No such route' } }
    return new Response(JSON.stringify(answer.body), { status: answer.status })
  }
  return { fetch, received }
}

const LIST = `GET ${PROFILE_VERSION_ROUTES.list}`
const listing = { status: 200, body: { versions: [], unsaved: false } }

/**
 * @param fetch - the home's request function.
 * @param options - whether the studio is at the computer, the dictionary and the download function.
 * @returns the rendered section and the files it handed to the browser.
 */
function renderSection(fetch: HostFetch, options: { atComputer?: boolean, dictionary?: typeof en } = {}) {
  const saved: { name: string; bytes: Uint8Array }[] = []
  const props = { t: makeTranslate(options.dictionary ?? en), close: () => {}, fetch, atComputer: () => options.atComputer ?? true, saveFile: (name: string, bytes: Uint8Array) => { saved.push({ name, bytes }) } } as VersionsSectionProps
  return { ...render(<VersionsSection {...props} />), saved }
}

/**
 * Choose a file in the hidden input.
 * @param container - the rendered section.
 * @param bytes - the file's contents.
 */
function choose(container: HTMLElement, bytes: Uint8Array): void {
  const input = container.querySelector('input[data-setup-file]') as HTMLInputElement
  const file = new File([bytes.slice()], 'setup.delorun', { type: 'application/zip' })
  Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.slice().buffer })
  fireEvent.change(input, { target: { files: [file] } })
}

/**
 * Wait for an element to appear.
 * @param container - the rendered section.
 * @param selector - what to find.
 * @returns the element.
 */
function appears(container: HTMLElement, selector: string): Promise<HTMLElement> {
  return waitFor(() => {
    const found = container.querySelector<HTMLElement>(selector)
    if (found === null) throw new Error(`${selector} has not appeared`)
    return found
  })
}

describe('Export setup', () => {
  it('hands the file the home wrote to the browser and says what went in and what was left out', async () => {
    const home = host({ [LIST]: listing, [`POST ${SETUP_PATHS.export}`]: { status: 200, body: EXPORTED } })
    const { saved } = renderSection(home.fetch)
    fireEvent.click(await screen.findByRole('button', { name: en['transfer.export'] }))
    expect((await screen.findByText(/Wrote setup\.delorun/u)).textContent).toContain('2 plugins (1 made on this computer')
    expect(saved).toHaveLength(1)
    expect(saved[0]!.name).toBe('setup.delorun')
    expect([...saved[0]!.bytes]).toEqual([1, 2, 3])
    expect(screen.getByText('sandbox-policy: belongs to this computer')).toBeTruthy()
    expect(home.received.find(request => request.key === `POST ${SETUP_PATHS.export}`)!.body).toEqual({})
  })

  it('shows the home\'s sentence when a settings row holds a key', async () => {
    const home = host({ [LIST]: listing, [`POST ${SETUP_PATHS.export}`]: { status: 422, body: { code: 'SETUP_REFUSED', message: 'Nothing was exported: llm-deepseek holds a value for the credential field apiKey.' } } })
    const { saved } = renderSection(home.fetch)
    fireEvent.click(await screen.findByRole('button', { name: en['transfer.export'] }))
    expect((await screen.findByRole('alert')).textContent).toContain('llm-deepseek holds a value for the credential field apiKey')
    expect(saved).toEqual([])
  })
})

describe('Import setup', () => {
  it('shows an unknown signer as unverified and every change, and replaces the setup only after Replace my setup', async () => {
    const home = host({ [LIST]: listing, [`POST ${SETUP_PATHS.inspect}`]: { status: 200, body: INSPECTED }, [`POST ${SETUP_PATHS.apply}`]: { status: 200, body: APPLIED } })
    const { container } = renderSection(home.fetch)
    await screen.findByRole('button', { name: en['transfer.import'] })
    choose(container, new Uint8Array([9, 8, 7]))
    const review = await appears(container, '[data-setup-review]')
    expect(within(review).getByText(/UNVERIFIED: signed by a key this computer does not know, fingerprint FP-OTHER/u)).toBeTruthy()
    expect(within(review).getByText('old-plugin')).toBeTruthy()
    expect(within(review).getByText('plug 1.0.0, made on another computer. Its code waits for your review.')).toBeTruthy()
    expect(within(review).getByText(/left-pad 1\.3\.0, from the registry\. \(now: version 1\.2\.0\)/u)).toBeTruthy()
    expect(within(review).getByText('changed: llm-deepseek')).toBeTruthy()
    expect(within(review).getByText(/https:\/\/m\.example\.com\/v1/u)).toBeTruthy()
    expect(within(review).getByText(en['transfer.protection.on'])).toBeTruthy()
    expect(home.received.find(request => request.key === `POST ${SETUP_PATHS.inspect}`)!.body).toEqual({ file: toBase64(new Uint8Array([9, 8, 7])) })
    // Nothing is applied before the second click.
    expect(home.received.some(request => request.key === `POST ${SETUP_PATHS.apply}`)).toBe(false)
    fireEvent.click(within(review).getByRole('button', { name: en['transfer.apply'] }))
    const done = await appears(container, '[data-setup-done]')
    expect(done.textContent).toContain('Before importing a setup')
    expect(done.textContent).toContain('plug')
    expect(done.textContent).toContain('The default model is deepseek-official / v4. Add its key.')
    expect(home.received.find(request => request.key === `POST ${SETUP_PATHS.apply}`)!.body).toEqual({ token: 'tok' })
  })

  it('names an unsigned file as unverified, and Cancel applies nothing', async () => {
    const unsigned: SetupInspectView = { ...INSPECTED, signer: { state: 'unverified', reason: 'absent', fingerprint: 'FP' }, protection: 'off' }
    const home = host({ [LIST]: listing, [`POST ${SETUP_PATHS.inspect}`]: { status: 200, body: unsigned } })
    const { container } = renderSection(home.fetch)
    await screen.findByRole('button', { name: en['transfer.import'] })
    choose(container, new Uint8Array([1]))
    const review = await appears(container, '[data-setup-review]')
    expect(within(review).getByText(en['transfer.signer.absent'])).toBeTruthy()
    expect(within(review).getByText(en['transfer.protection.off'])).toBeTruthy()
    fireEvent.click(within(review).getByRole('button', { name: en['transfer.cancel'] }))
    expect(container.querySelector('[data-setup-review]')).toBeNull()
    expect(home.received.some(request => request.key === `POST ${SETUP_PATHS.apply}`)).toBe(false)
  })

  it('offers no Replace button when the profile already has the setup, shows a file the home refused, and a refusal to apply', async () => {
    const same: SetupInspectView = { ...INSPECTED, install: [], remove: [], settings: [], changes: false }
    const refused = host({ [LIST]: listing, [`POST ${SETUP_PATHS.inspect}`]: { status: 422, body: { code: 'ARCHIVE_CHECKSUM_MISMATCH', message: 'The entry is not the content its manifest digest names.' } } })
    const first = renderSection(refused.fetch)
    await screen.findByRole('button', { name: en['transfer.import'] })
    choose(first.container, new Uint8Array([1]))
    expect((await screen.findByRole('alert')).textContent).toContain('manifest digest')
    cleanup()
    const unchanged = host({ [LIST]: listing, [`POST ${SETUP_PATHS.inspect}`]: { status: 200, body: same } })
    const second = renderSection(unchanged.fetch)
    await screen.findByRole('button', { name: en['transfer.import'] })
    choose(second.container, new Uint8Array([1]))
    const review = await appears(second.container, '[data-setup-review]')
    expect(within(review).getByText(en['transfer.nothing'])).toBeTruthy()
    expect(within(review).queryByRole('button', { name: en['transfer.apply'] })).toBeNull()
    cleanup()
    const failing = host({ [LIST]: listing, [`POST ${SETUP_PATHS.inspect}`]: { status: 200, body: INSPECTED }, [`POST ${SETUP_PATHS.apply}`]: { status: 410, body: { code: 'SETUP_EXPIRED', message: 'This setup file is no longer waiting. Choose the file again.' } } })
    const third = renderSection(failing.fetch)
    await screen.findByRole('button', { name: en['transfer.import'] })
    choose(third.container, new Uint8Array([1]))
    const open = await appears(third.container, '[data-setup-review]')
    fireEvent.click(within(open).getByRole('button', { name: en['transfer.apply'] }))
    expect((await screen.findByRole('alert')).textContent).toContain('no longer waiting')
  })

  it('says in place that only the home\'s own computer moves a setup, and offers no button elsewhere', async () => {
    const home = host({ [LIST]: listing })
    renderSection(home.fetch, { atComputer: false })
    await screen.findByText(en.atComputer)
    expect(screen.queryByRole('button', { name: en['transfer.export'] })).toBeNull()
    expect(screen.queryByRole('button', { name: en['transfer.import'] })).toBeNull()
    cleanup()
    const refused = host({ [LIST]: listing, [`POST ${SETUP_PATHS.export}`]: { status: 403, body: { code: 'LOOPBACK_REQUIRED', message: 'This needs you at your computer.' } } })
    renderSection(refused.fetch)
    fireEvent.click(await screen.findByRole('button', { name: en['transfer.export'] }))
    expect((await screen.findByRole('alert')).textContent).toBe(en.loopback)
  })

  it('has every sentence in the Chinese dictionary and round trips base64', async () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    expect([...fromBase64(toBase64(new Uint8Array(70_000).fill(7)))].every(byte => byte === 7)).toBe(true)
  })
})
