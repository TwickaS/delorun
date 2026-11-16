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

const EXPORTED: SetupExportView = { file: toBase64(new Uint8Array([1, 2, 3])), name: 'setup.delorun', plugins: 2, local: 1, settings: 3, leftOut: [{ subject: 'sandbox-policy', code: 'computer' }], signedBy: 'KEY123', withoutCode: [] }
const PLUGINS = { plugins: [{ name: 'plug', source: 'local' }, { name: 'left-pad', source: 'registry' }] }
const INSPECTED: SetupInspectView = {
  token: 'tok', signer: { state: 'unverified', reason: 'key-not-trusted', fingerprint: 'FP-OTHER' }, createdBy: '0.1.0', exportedAt: '2026-11-16T10:00:00Z', sourceProfile: 'default', note: 'my work setup', includesSettings: true, named: [],
  replaces: ['plugins-listed', 'model', 'settings'],
  install: [{ name: 'plug', version: '1.0.0', kind: 'add', source: 'local' }, { name: 'left-pad', version: '1.3.0', kind: 'replace', source: 'registry', was: { kind: 'version', version: '1.2.0' } }],
  remove: ['old-plugin'], keep: [], settingChanges: [{ kind: 'changed', label: 'llm-deepseek' }], endpoints: [{ field: 'providers.x.baseURL', url: 'https://m.example.com/v1' }], leftOut: [{ subject: 'sandbox-policy', code: 'computer' }],
  keys: [{ kind: 'model', provider: 'deepseek-official', model: 'v4' }], protection: 'on', changes: true,
}
const APPLIED: SetupApplyView = { savedVersion: 'v'.repeat(40), removed: ['old-plugin'], installed: [{ name: 'plug', reviewChange: 'c0123456789' }, { name: 'left-pad' }], settingsWritten: true, keys: [{ kind: 'model', provider: 'deepseek-official', model: 'v4' }], protection: 'on' }

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
  const EXPORT = `POST ${SETUP_PATHS.export}`
  const bodies = (home: ReturnType<typeof host>): unknown[] => home.received.filter(request => request.key === EXPORT).map(request => request.body)

  it('asks what goes in, then hands the file the home wrote to the browser and says what was left out', async () => {
    const home = host({ [LIST]: listing, [EXPORT]: { status: 200, body: EXPORTED } })
    const { saved } = renderSection((input, init) => typeof init?.body === 'string' && (JSON.parse(init.body) as { list?: boolean }).list === true
      ? Promise.resolve(new Response(JSON.stringify(PLUGINS), { status: 200 }))
      : home.fetch(input, init))
    fireEvent.click(await screen.findByRole('button', { name: en['transfer.export'] }))
    fireEvent.click(await screen.findByRole('button', { name: en['transfer.write'] }))
    expect((await screen.findByText(/Wrote setup\.delorun/u)).textContent).toContain('2 plugins (1 made on this computer')
    expect(bodies(home)).toEqual([{ settings: true, localCode: true }])
    expect(saved).toHaveLength(1)
    expect([...saved[0]!.bytes]).toEqual([1, 2, 3])
    expect(screen.getByText('sandbox-policy belongs to this computer, so a setup does not carry it.')).toBeTruthy()
  })

  it('sends the choices: no settings, no code of one\'s own, one plugin, a note', async () => {
    const home = host({ [LIST]: listing, [EXPORT]: { status: 200, body: { ...EXPORTED, withoutCode: ['plug'] } } })
    renderSection((input, init) => typeof init?.body === 'string' && (JSON.parse(init.body) as { list?: boolean }).list === true
      ? Promise.resolve(new Response(JSON.stringify(PLUGINS), { status: 200 }))
      : home.fetch(input, init))
    fireEvent.click(await screen.findByRole('button', { name: en['transfer.export'] }))
    const form = await waitFor(() => screen.getByRole('button', { name: en['transfer.write'] }).closest('[data-setup-export-form]') as HTMLElement)
    fireEvent.click(within(form).getByRole('switch', { name: en['transfer.settings.switch'] }))
    fireEvent.click(within(form).getByRole('switch', { name: en['transfer.localCode'] }))
    fireEvent.click(within(form).getByRole('checkbox', { name: 'left-pad' }))
    fireEvent.change(within(form).getByLabelText(en['transfer.note']), { target: { value: ' for the team ' } })
    fireEvent.click(within(form).getByRole('button', { name: en['transfer.write'] }))
    await screen.findByText(/Wrote setup\.delorun/u)
    expect(bodies(home)).toEqual([{ settings: false, localCode: false, plugins: ['plug'], note: 'for the team' }])
    expect(screen.getByText(/These plugins of yours went in without their code\. Copy them to the other computer yourself: plug\./u)).toBeTruthy()
  })

  it('shows the home\'s sentence when a settings row holds a key', async () => {
    const home = host({ [LIST]: listing, [EXPORT]: { status: 422, body: { code: 'SETUP_REFUSED', message: 'Nothing was exported: llm-deepseek holds a value for the credential field apiKey.' } } })
    const { saved } = renderSection((input, init) => typeof init?.body === 'string' && (JSON.parse(init.body) as { list?: boolean }).list === true
      ? Promise.resolve(new Response(JSON.stringify(PLUGINS), { status: 200 }))
      : home.fetch(input, init))
    fireEvent.click(await screen.findByRole('button', { name: en['transfer.export'] }))
    fireEvent.click(await screen.findByRole('button', { name: en['transfer.write'] }))
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
    expect(within(review).getByText('Changed llm-deepseek')).toBeTruthy()
    expect(within(review).getByText('providers.x.baseURL sends requests to https://m.example.com/v1')).toBeTruthy()
    expect(within(review).getByText('sandbox-policy belongs to this computer, so a setup does not carry it.')).toBeTruthy()
    expect(within(review).getByText(/https:\/\/m\.example\.com\/v1/u)).toBeTruthy()
    expect(within(review).getByText(en['transfer.protection.on'])).toBeTruthy()
    expect(home.received.find(request => request.key === `POST ${SETUP_PATHS.inspect}`)!.body).toEqual({ file: toBase64(new Uint8Array([9, 8, 7])), settings: true, removeOthers: false })
    expect(within(review).getByText(/Note from the sender: my work setup/u)).toBeTruthy()
    expect(within(review).getByText(/Importing replaces these parts of this profile: the plugins the file lists \(others stay\); model provider and model choices; other settings\./u)).toBeTruthy()
    // Nothing is applied before the second click.
    expect(home.received.some(request => request.key === `POST ${SETUP_PATHS.apply}`)).toBe(false)
    fireEvent.click(within(review).getByRole('button', { name: en['transfer.apply'] }))
    const done = await appears(container, '[data-setup-done]')
    expect(done.textContent).toContain('Before importing a setup')
    expect(done.textContent).toContain('plug')
    expect(done.textContent).toContain('The default model is deepseek-official / v4. Add its key with delorun setup key')
    expect(home.received.find(request => request.key === `POST ${SETUP_PATHS.apply}`)!.body).toEqual({ token: 'tok', settings: true, removeOthers: false })
  })

  it('plans again when Include settings or Remove plugins not in this archive is switched, and offers the first only when the file has settings', async () => {
    const home = host({ [LIST]: listing, [`POST ${SETUP_PATHS.inspect}`]: { status: 200, body: INSPECTED }, [`POST ${SETUP_PATHS.apply}`]: { status: 200, body: APPLIED } })
    const { container } = renderSection(home.fetch)
    await screen.findByRole('button', { name: en['transfer.import'] })
    choose(container, new Uint8Array([1]))
    const review = await appears(container, '[data-setup-review]')
    fireEvent.click(within(review).getByRole('switch', { name: en['transfer.settings.switch'] }))
    await waitFor(() => expect(home.received.filter(request => request.key === `POST ${SETUP_PATHS.inspect}`).at(-1)!.body).toEqual({ token: 'tok', settings: false, removeOthers: false }))
    fireEvent.click(within(await appears(container, '[data-setup-review]')).getByRole('switch', { name: en['transfer.removeOthers'] }))
    await waitFor(() => expect(home.received.filter(request => request.key === `POST ${SETUP_PATHS.inspect}`).at(-1)!.body).toEqual({ token: 'tok', settings: false, removeOthers: true }))
    fireEvent.click(within(await appears(container, '[data-setup-review]')).getByRole('button', { name: en['transfer.apply'] }))
    await appears(container, '[data-setup-done]')
    expect(home.received.find(request => request.key === `POST ${SETUP_PATHS.apply}`)!.body).toEqual({ token: 'tok', settings: false, removeOthers: true })
    cleanup()
    const bare = host({ [LIST]: listing, [`POST ${SETUP_PATHS.inspect}`]: { status: 200, body: { ...INSPECTED, includesSettings: false, note: undefined } } })
    const second = renderSection(bare.fetch)
    await screen.findByRole('button', { name: en['transfer.import'] })
    choose(second.container, new Uint8Array([1]))
    const open = await appears(second.container, '[data-setup-review]')
    expect(within(open).queryByRole('switch', { name: en['transfer.settings.switch'] })).toBeNull()
    expect(within(open).getByRole('switch', { name: en['transfer.removeOthers'] })).toBeTruthy()
    expect(within(open).queryByText(/Note from the sender/u)).toBeNull()
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
    const same: SetupInspectView = { ...INSPECTED, install: [], remove: [], settingChanges: [], changes: false }
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

  it('words everything the home sends as codes in the Chinese dictionary, with no English left over', async () => {
    const home = host({ [LIST]: listing, [`POST ${SETUP_PATHS.inspect}`]: { status: 200, body: INSPECTED }, [`POST ${SETUP_PATHS.apply}`]: { status: 200, body: APPLIED } })
    const { container } = renderSection(home.fetch, { dictionary: zh })
    await screen.findByRole('button', { name: zh['transfer.import'] })
    choose(container, new Uint8Array([1]))
    const review = await appears(container, '[data-setup-review]')
    for (const text of [
      '更改 llm-deepseek', 'providers.x.baseURL 将向 https://m.example.com/v1 发送请求', 'sandbox-policy 属于这台电脑，因此 setup 不携带它。',
    ]) expect(within(review).getByText(text), text).toBeTruthy()
    expect(within(review).getByText(/^导入会替换此 profile 的这些部分：文件所列的插件（其他插件保留）; 模型提供方与模型选择; 其他设置。/u)).toBeTruthy()
    expect(within(review).getByText(/当前：版本 1\.2\.0/u)).toBeTruthy()
    fireEvent.click(within(review).getByRole('button', { name: zh['transfer.apply'] }))
    const done = await appears(container, '[data-setup-done]')
    expect(done.textContent).toContain('默认模型是 deepseek-official / v4。')
    expect(done.textContent).not.toMatch(/The default model|Add its key/u)
  })

  it('has every sentence in the Chinese dictionary and round trips base64', async () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    expect([...fromBase64(toBase64(new Uint8Array(70_000).fill(7)))].every(byte => byte === 7)).toBe(true)
  })
})
