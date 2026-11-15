// @vitest-environment jsdom
/**
 * The Network section reads each workspace's network from the home, saves a tightening at once, asks before a change
 * that loosens the network and sends the confirmation only after the person gives it, and says in place when the home
 * serves the setting only to its own computer, refuses a change or cannot read its store.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { apply as connectionApply } from '@deepseek-ai/dsh-client-connection/client'
import { makeTranslate, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, EXTERNAL_AGENTS_SECTION_ORDER, inject, NETWORK_SECTION_ID, NETWORK_SECTION_ORDER, readNetworks } from '../src/client/index.ts'
import type { HostFetch } from '../src/client/host-api.ts'
import {
  addedHosts, comparableHosts, hostLines, NETWORK_ROUTES, sameNetwork, setNetwork, type WorkspaceNetwork,
} from '../src/client/network-api.ts'
import { PERMISSION_ROUTES } from '@delorun/plugin-permission-defaults/wire'
import { en, zh } from '../src/client/network-locales.ts'
import { looseningText, NetworkSection, type NetworkSectionProps } from '../src/client/NetworkSection.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** One scripted Host answer: a JSON body, a raw text body, or a request that never completes. */
type Answer = { status: number; body?: unknown; text?: string } | 'unreachable'

/** A route key: the method and the path. */
type RouteKey = `${'GET' | 'POST'} ${string}`

/** One request the fake Host received. */
interface Received {
  readonly key: RouteKey
  readonly body: unknown
}

/**
 * A fake home answering each route with the next scripted answer, the last one repeating; an unscripted route answers
 * 404 as the Host's router does.
 * @param script - the answers by route, one or several in order.
 * @returns the fake `fetch`, the received requests, the script and a counter.
 */
function fakeHost(script: Partial<Record<RouteKey, Answer | Answer[]>> = {}) {
  const received: Received[] = []
  const fetch: HostFetch = async (input, init) => {
    const key: RouteKey = `${init?.method === 'POST' ? 'POST' : 'GET'} ${input}`
    received.push({ key, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined })
    const entry = script[key] ?? { status: 404, body: { error: 'NOT_FOUND', message: 'No such route' } }
    const answer = Array.isArray(entry) ? (entry.length > 1 ? entry.shift() : entry[0]) : entry
    if (answer === undefined || answer === 'unreachable') throw new TypeError('Failed to fetch')
    return new Response(answer.text ?? JSON.stringify(answer.body), { status: answer.status })
  }
  const posts = (): unknown[] => received.filter(request => request.key === `POST ${NETWORK_ROUTES.set}`).map(request => request.body)
  const count = (key: RouteKey): number => received.filter(request => request.key === key).length
  return { fetch, received, script, posts, count }
}

const OPEN: WorkspaceNetwork = { access: 'open', hosts: [] }
const ALPHA = { path: '/home/me/alpha', title: 'Alpha', network: OPEN, own: false }
const BETA = { path: '/home/me/beta', title: 'Beta', network: { access: 'allowlist', hosts: ['registry.npmjs.org'] }, own: true }
const LIST = { status: 200, body: { default: OPEN, workspaces: [ALPHA, BETA] } }
const refusal = (status: number, error: string, message = `${error} sentence`) => ({ status, body: { error, message } })
const saved = (network: WorkspaceNetwork) => ({ status: 200, body: { network } })
const UNCONFIRMED = refusal(409, 'NETWORK_UNCONFIRMED', 'this change lets the workspace\'s commands reach more of the network, so the person confirms it first')

/**
 * Render the section over a fake home.
 * @param host - the fake home.
 * @returns the render result.
 */
function renderSection(host: ReturnType<typeof fakeHost>) {
  // The renderer's standard props are absent: the section reads none of them.
  const props = { t: makeTranslate(en), close: () => {}, fetch: host.fetch } as NetworkSectionProps
  return render(<NetworkSection {...props} />)
}

/**
 * The row of one workspace, once the list shows.
 * @param title - the workspace's title.
 * @returns the row.
 */
async function rowOf(title: string): Promise<HTMLElement> {
  const row = (await screen.findByText(title)).closest('li')
  if (row === null) throw new Error(`no row for ${title}`)
  return row
}

describe('the Network section', () => {
  it('says only that the setting is not available in a profile without it', async () => {
    renderSection(fakeHost())
    expect(await screen.findByText(en.unavailable)).toBeTruthy()
    expect(screen.queryByText(en.intro)).toBeNull()
  })

  it('lists each workspace with its folder, its access and whether it follows the default', async () => {
    renderSection(fakeHost({ [`GET ${NETWORK_ROUTES.list}`]: LIST }))
    const alpha = await rowOf('Alpha')
    expect(screen.getByText(en.intro)).toBeTruthy()
    expect(within(alpha).getByText('/home/me/alpha')).toBeTruthy()
    expect(within(alpha).getByText('Default: Open')).toBeTruthy()
    expect(within(alpha).getByRole('tab', { name: en['access.open'] }).getAttribute('aria-selected')).toBe('true')
    expect(within(alpha).queryByRole('button', { name: en.useDefault })).toBeNull()
    expect((within(alpha).getByRole('button', { name: en.save }) as HTMLButtonElement).disabled).toBe(true)
    const beta = await rowOf('Beta')
    expect(within(beta).getByText('Set for this workspace. Default: Open')).toBeTruthy()
    expect(within(beta).getByRole('tab', { name: en['access.allowlist'] }).getAttribute('aria-selected')).toBe('true')
    expect((within(beta).getByRole('textbox', { name: 'Allowed hosts of Beta, one per line' }) as HTMLTextAreaElement).value).toBe('registry.npmjs.org')
    expect(within(beta).getByText(en['hosts.hint'])).toBeTruthy()
    expect(within(beta).getByRole('button', { name: en.useDefault })).toBeTruthy()
  })

  it('shows no workspaces yet for an empty list', async () => {
    renderSection(fakeHost({ [`GET ${NETWORK_ROUTES.list}`]: { status: 200, body: { default: OPEN, workspaces: [] } } }))
    expect(await screen.findByText(en.none)).toBeTruthy()
  })

  it('saves a tightening at once, without confirmed, and reads the list again', async () => {
    const off: WorkspaceNetwork = { access: 'off', hosts: [] }
    const host = fakeHost({
      [`GET ${NETWORK_ROUTES.list}`]: [LIST, { status: 200, body: { default: OPEN, workspaces: [{ ...ALPHA, network: off, own: true }, BETA] } }],
      [`POST ${NETWORK_ROUTES.set}`]: saved(off),
    })
    renderSection(host)
    const alpha = await rowOf('Alpha')
    fireEvent.click(within(alpha).getByRole('tab', { name: en['access.off'] }))
    expect(within(alpha).getByText(en['access.off.description'])).toBeTruthy()
    fireEvent.click(within(alpha).getByRole('button', { name: en.save }))
    await vi.waitFor(async () => { expect(within(await rowOf('Alpha')).getByText('Set for this workspace. Default: Open')).toBeTruthy() })
    expect(host.posts()).toEqual([{ path: ALPHA.path, network: off }])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(host.count(`GET ${NETWORK_ROUTES.list}`)).toBe(2)
  })

  it('confirms a loosening before it resends the change with confirmed', async () => {
    const host = fakeHost({
      [`GET ${NETWORK_ROUTES.list}`]: LIST,
      [`POST ${NETWORK_ROUTES.set}`]: [UNCONFIRMED, saved(OPEN)],
    })
    renderSection(host)
    const beta = await rowOf('Beta')
    fireEvent.click(within(beta).getByRole('tab', { name: en['access.open'] }))
    fireEvent.click(within(beta).getByRole('button', { name: en.save }))
    const dialog = await screen.findByRole('dialog', { name: 'Let Beta reach more of the network?' })
    expect(within(dialog).getByText('Commands in Beta will be able to reach any host on the internet.')).toBeTruthy()
    expect(host.posts()).toEqual([{ path: BETA.path, network: { access: 'open', hosts: ['registry.npmjs.org'] } }])
    fireEvent.click(within(dialog).getByRole('button', { name: en['confirm.accept'] }))
    await vi.waitFor(() => { expect(host.posts()).toHaveLength(2) })
    expect(host.posts()[1]).toEqual({ path: BETA.path, network: { access: 'open', hosts: ['registry.npmjs.org'] }, confirmed: true })
    expect(screen.queryByRole('dialog')).toBeNull()
    await vi.waitFor(() => { expect(host.count(`GET ${NETWORK_ROUTES.list}`)).toBe(2) })
  })

  it('offers the abstract-socket switch under open only, sends it after the person confirms what it opens, and shows it on when accepted', async () => {
    const accepted: WorkspaceNetwork = { access: 'open', hosts: [], acceptAbstractSockets: true }
    const host = fakeHost({
      [`GET ${NETWORK_ROUTES.list}`]: [LIST, { status: 200, body: { default: OPEN, workspaces: [{ ...ALPHA, network: accepted, own: true }, BETA] } }],
      [`POST ${NETWORK_ROUTES.set}`]: [UNCONFIRMED, saved(accepted)],
    })
    renderSection(host)
    const alpha = await rowOf('Alpha')
    const toggle = within(alpha).getByRole('switch', { name: en['abstract.title'] })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(within(alpha).getByRole('tab', { name: en['access.off'] }))
    expect(within(alpha).queryByRole('switch', { name: en['abstract.title'] })).toBeNull()
    fireEvent.click(within(alpha).getByRole('tab', { name: en['access.open'] }))
    fireEvent.click(within(alpha).getByRole('switch', { name: en['abstract.title'] }))
    fireEvent.click(within(alpha).getByRole('button', { name: en.save }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(en['confirm.abstract'].replace('{workspace}', 'Alpha'))).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: en['confirm.accept'] }))
    await vi.waitFor(() => { expect(host.posts()).toHaveLength(2) })
    expect(host.posts()).toEqual([{ path: ALPHA.path, network: accepted }, { path: ALPHA.path, network: accepted, confirmed: true }])
    await vi.waitFor(async () => { expect(within(await rowOf('Alpha')).getByRole('switch', { name: en['abstract.title'] }).getAttribute('aria-checked')).toBe('true') })
  })

  it.each([
    { how: 'Cancel', control: en['confirm.cancel'] },
    { how: 'the close button', control: en['confirm.close'] },
  ])('sends nothing more when the person leaves the confirmation with $how', async ({ control }) => {
    const host = fakeHost({ [`GET ${NETWORK_ROUTES.list}`]: LIST, [`POST ${NETWORK_ROUTES.set}`]: UNCONFIRMED })
    renderSection(host)
    const alpha = await rowOf('Alpha')
    fireEvent.click(within(alpha).getByRole('tab', { name: en['access.allowlist'] }))
    fireEvent.click(within(alpha).getByRole('button', { name: en.save }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: control }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(host.posts()).toHaveLength(1)
    expect(host.count(`GET ${NETWORK_ROUTES.list}`)).toBe(1)
    // The draft stays for the person to change or save again.
    expect(within(alpha).getByRole('tab', { name: en['access.allowlist'] }).getAttribute('aria-selected')).toBe('true')
  })

  it('offers common hosts for review, adds nothing on its own, and names the added hosts in the confirmation', async () => {
    const host = fakeHost({ [`GET ${NETWORK_ROUTES.list}`]: LIST, [`POST ${NETWORK_ROUTES.set}`]: UNCONFIRMED })
    renderSection(host)
    const beta = await rowOf('Beta')
    fireEvent.click(within(beta).getByRole('button', { name: en['common.add'] }))
    expect(within(beta).getByText(en['common.hint'])).toBeTruthy()
    fireEvent.click(within(beta).getByRole('button', { name: en['common.pypi'] }))
    fireEvent.click(within(beta).getByRole('button', { name: en['common.npm'] }))
    fireEvent.click(within(beta).getByRole('button', { name: en['common.go'] }))
    const hosts = within(beta).getByRole('textbox', { name: 'Allowed hosts of Beta, one per line' }) as HTMLTextAreaElement
    expect(hosts.value).toBe('registry.npmjs.org\npypi.org\nfiles.pythonhosted.org\nproxy.golang.org\nsum.golang.org')
    expect(host.posts()).toHaveLength(0)
    fireEvent.click(within(beta).getByRole('button', { name: en.save }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Commands in Beta will be able to reach these added hosts: files.pythonhosted.org, proxy.golang.org, pypi.org, sum.golang.org.')).toBeTruthy()
    expect(host.posts()).toEqual([{ path: BETA.path, network: { access: 'allowlist', hosts: ['registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org', 'proxy.golang.org', 'sum.golang.org'] } }])
  })

  it('returns a workspace to the default with a request that names no network', async () => {
    const host = fakeHost({
      [`GET ${NETWORK_ROUTES.list}`]: [LIST, { status: 200, body: { default: OPEN, workspaces: [ALPHA, { ...BETA, network: OPEN, own: false }] } }],
      [`POST ${NETWORK_ROUTES.set}`]: [UNCONFIRMED, saved(OPEN)],
    })
    renderSection(host)
    fireEvent.click(within(await rowOf('Beta')).getByRole('button', { name: en.useDefault }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Commands in Beta will be able to reach any host on the internet.')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: en['confirm.accept'] }))
    await vi.waitFor(async () => { expect(within(await rowOf('Beta')).getByText('Default: Open')).toBeTruthy() })
    expect(host.posts()).toEqual([{ path: BETA.path }, { path: BETA.path, confirmed: true }])
  })

  it('shows the Host\'s sentence in the row for a host entry it refuses, and keeps the draft', async () => {
    const message = '"https://example.com" is not a host name: write a name such as registry.npmjs.org or *.npmjs.org, with no scheme or path, and a port only after a colon'
    const host = fakeHost({ [`GET ${NETWORK_ROUTES.list}`]: LIST, [`POST ${NETWORK_ROUTES.set}`]: refusal(422, 'NETWORK_INVALID', message) })
    renderSection(host)
    const beta = await rowOf('Beta')
    const hosts = within(beta).getByRole('textbox', { name: 'Allowed hosts of Beta, one per line' })
    fireEvent.change(hosts, { target: { value: 'registry.npmjs.org\nhttps://example.com\n' } })
    fireEvent.click(within(beta).getByRole('button', { name: en.save }))
    expect((await within(beta).findByRole('alert')).textContent).toBe(message)
    expect(host.posts()).toEqual([{ path: BETA.path, network: { access: 'allowlist', hosts: ['registry.npmjs.org', 'https://example.com'] } }])
    expect((hosts as HTMLTextAreaElement).value).toBe('registry.npmjs.org\nhttps://example.com\n')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows the store\'s problem in place and refuses changes while it lasts', async () => {
    const problem = 'network.json is not valid JSON'
    renderSection(fakeHost({ [`GET ${NETWORK_ROUTES.list}`]: { status: 200, body: { default: OPEN, workspaces: [{ ...BETA, network: { access: 'off', hosts: [] } }], problem } } }))
    const beta = await rowOf('Beta')
    expect(screen.getByRole('alert').textContent).toBe(en.problem.replace('{problem}', problem))
    expect((within(beta).getByRole('tab', { name: en['access.open'] }) as HTMLButtonElement).disabled).toBe(true)
    expect((within(beta).getByRole('button', { name: en.useDefault }) as HTMLButtonElement).disabled).toBe(true)
    expect((within(beta).getByRole('button', { name: en.save }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('says that only the home\'s own computer reads and changes the setting', async () => {
    const message = 'A workspace\'s network is read and changed only in the studio on the home\'s own computer'
    renderSection(fakeHost({ [`GET ${NETWORK_ROUTES.list}`]: refusal(403, 'LOOPBACK_REQUIRED', message) }))
    expect((await screen.findByRole('alert')).textContent).toBe(en.loopback)
    expect(screen.queryByText(message)).toBeNull()
    expect(screen.queryByRole('listitem')).toBeNull()
  })

  it('says to unlock this device, not to go to the computer, while dangerous mode is on', async () => {
    // Pins the mode read: the same refusal reads as the computer's sentence while the everywhere route says off.
    renderSection(fakeHost({
      [`GET ${NETWORK_ROUTES.list}`]: refusal(403, 'LOOPBACK_REQUIRED'),
      [`GET ${PERMISSION_ROUTES.everywhere}`]: { status: 200, body: { on: true } },
    }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en.loopbackUnlock) })
  })

  it('says so in the row for a change refused away from the home\'s computer', async () => {
    const host = fakeHost({ [`GET ${NETWORK_ROUTES.list}`]: LIST, [`POST ${NETWORK_ROUTES.set}`]: refusal(403, 'LOOPBACK_REQUIRED') })
    renderSection(host)
    const alpha = await rowOf('Alpha')
    fireEvent.click(within(alpha).getByRole('tab', { name: en['access.off'] }))
    fireEvent.click(within(alpha).getByRole('button', { name: en.save }))
    expect((await within(alpha).findByRole('alert')).textContent).toBe(en.loopback)
  })

  it.each([
    { name: 'an unreachable home', answer: 'unreachable' as const, shown: en['failed.unreachable'] },
    { name: 'an answer that is not JSON', answer: { status: 200, text: '<html>' }, shown: en['failed.unreadable'] },
    { name: 'an answer of the wrong form', answer: { status: 200, body: { default: { access: 'wide', hosts: [] }, workspaces: [] } }, shown: en['failed.unreadable'] },
    { name: 'another refusal', answer: refusal(500, 'INTERNAL', 'The home could not list its workspaces.'), shown: 'The home could not list its workspaces.' },
  ])('says what failed for $name', async ({ answer, shown }) => {
    renderSection(fakeHost({ [`GET ${NETWORK_ROUTES.list}`]: answer }))
    expect((await screen.findByRole('alert')).textContent).toBe(shown)
  })

  it('has a Chinese entry for every English key', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })
})

describe('the network requests', () => {
  it('send same-origin requests, and confirmed only when the change says so', async () => {
    const host = fakeHost({ [`GET ${NETWORK_ROUTES.list}`]: LIST, [`POST ${NETWORK_ROUTES.set}`]: saved(OPEN) })
    expect(await readNetworks(host.fetch)).toEqual(LIST.body)
    expect(await setNetwork(host.fetch, { path: ALPHA.path, network: OPEN, confirmed: false })).toEqual(OPEN)
    await setNetwork(host.fetch, { path: ALPHA.path, confirmed: true })
    expect(host.posts()).toEqual([{ path: ALPHA.path, network: OPEN }, { path: ALPHA.path, confirmed: true }])
    expect(await readNetworks(fakeHost().fetch)).toBeUndefined()
  })

  it('read the editor\'s lines and compare host lists', () => {
    expect(hostLines(' a.example.com \n\n*.b.example.com\n')).toEqual(['a.example.com', '*.b.example.com'])
    expect(comparableHosts(['B.example.com', 'a.example.com', 'b.example.com'])).toEqual(['a.example.com', 'b.example.com'])
    expect(sameNetwork({ access: 'allowlist', hosts: ['A.example.com'] }, { access: 'allowlist', hosts: ['a.example.com'] })).toBe(true)
    expect(sameNetwork({ access: 'allowlist', hosts: [] }, { access: 'off', hosts: [] })).toBe(false)
    expect(sameNetwork({ access: 'open', hosts: [] }, { access: 'open', hosts: [], acceptAbstractSockets: true })).toBe(false)
  })

  it('name the hosts an allowlist adds, a wildcard admitting the names below it', () => {
    const previous: WorkspaceNetwork = { access: 'allowlist', hosts: ['*.npmjs.org', 'pypi.org'] }
    expect(addedHosts(previous, ['registry.npmjs.org', 'pypi.org', 'github.com'])).toEqual(['github.com'])
    expect(addedHosts({ access: 'off', hosts: ['pypi.org'] }, ['pypi.org'])).toEqual(['pypi.org'])
  })

  it('state more of the network when no added host is known', () => {
    const t = makeTranslate(en) as NetworkSectionProps['t']
    expect(looseningText(t, 'Alpha', { access: 'allowlist', hosts: ['*.npmjs.org'] }, { access: 'allowlist', hosts: ['registry.npmjs.org'] }))
      .toBe('Commands in Alpha will be able to reach more of the network.')
    expect(looseningText(t, 'Alpha', { access: 'off', hosts: [] }, { access: 'off', hosts: [] }))
      .toBe('Commands in Alpha will be able to reach more of the network.')
  })
})

describe('the plugin', () => {
  it('registers the Network section right after External agents, with the browser\'s fetch', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SlotRegistry).await()
      ctx.provide('locale', new LocaleRuntime(ctx))
      // Read only when the "Allow for this chat" choice switches a live chat.
      ctx.provide('sessions', {})
      new TestRemote(ctx, { settings: { describe: vi.fn(async () => ({ ok: true as const, value: { writable: true, hasDocument: true, namespaces: [] } })) } })
      await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
      const slots = ctx.get('slots')
      if (slots === undefined) throw new Error('no slot registry')
      slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' }, 'settings.onboarding': { kind: 'list', scope: 'root' }, 'sidebar.brand.mark': { kind: 'single', scope: 'root' }, 'sidebar.brand.name': { kind: 'single', scope: 'root' } }, inject: () => ({}) },
        ({ renderSlot }) => <>{renderSlot('settings.section', { close: () => {} })}</>)
      await ctx.plugin({ inject: [], apply: connectionApply }).await()
      await ctx.plugin({ inject, apply }).await()
      const entry = slots.entries('settings.section').find(section => section.options.id === NETWORK_SECTION_ID)
      if (entry === undefined) throw new Error('no Network section')
      expect(entry.options.order).toBe(NETWORK_SECTION_ORDER)
      expect(NETWORK_SECTION_ORDER).toBe(EXTERNAL_AGENTS_SECTION_ORDER + 1)
      expect(typeof entry.options.label === 'function' ? entry.options.label() : entry.options.label).toBe(en.nav)
      const browserFetch = vi.fn(async () => Response.json(LIST.body))
      vi.stubGlobal('fetch', browserFetch)
      const face = entry.inject?.() as { fetch: HostFetch }
      expect((entry.inject?.() as { fetch: HostFetch }).fetch).toBe(face.fetch)
      expect(await readNetworks(face.fetch)).toEqual(LIST.body)
      expect(browserFetch).toHaveBeenCalledWith(NETWORK_ROUTES.list, expect.objectContaining({ credentials: 'same-origin' }))
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
