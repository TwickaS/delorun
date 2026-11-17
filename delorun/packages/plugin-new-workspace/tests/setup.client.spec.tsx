// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserReadiness } from '@delorun/browser-setup'
import type { NewWorkspaceApi } from '../src/client/api.ts'
import type { FullAccessAsk } from '../src/client/create.ts'
import { en } from '../src/client/locales.ts'
import type { ModelCatalogView } from '../src/client/models.ts'
import { NewWorkspaceDialog } from '../src/client/NewWorkspaceDialog.tsx'
import { CATALOG, failure, fakeApi, fakeBrowse, fakeBrowser, fakeFullAccess, HOME, NOW, ok, t } from './fixtures.client.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const settle = async () => { await act(async () => { for (let n = 0; n < 8; n++) await Promise.resolve() }) }
const click = async (element: HTMLElement) => { await act(async () => { fireEvent.click(element) }); await settle() }
const type = async (element: HTMLElement, value: string) => { await act(async () => { fireEvent.change(element, { target: { value } }) }); await settle() }
const choose = async (element: HTMLElement, value: string) => { await act(async () => { fireEvent.change(element, { target: { value } }) }); await settle() }
const button = (name: string | RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement
const heading = () => screen.getByRole('heading', { level: 2 }).textContent
const modelSelect = () => screen.getByLabelText(en['model.model']) as HTMLSelectElement
const thinkingSelect = () => screen.getByLabelText(en['model.thinking']) as HTMLSelectElement
const radio = (name: string) => screen.getByRole('radio', { name: new RegExp(`^${name}`) }) as HTMLInputElement
/** The text a select shows for its current value. */
const shown = (select: HTMLSelectElement) => select.selectedOptions[0]?.textContent

interface Options {
  readonly api?: Partial<NewWorkspaceApi>
  readonly catalog?: ModelCatalogView | null
  readonly fullAccess?: FullAccessAsk
  readonly readiness?: BrowserReadiness
}

/** The dialog over a fake Host, on the model screen of a new folder called `site`. */
async function atModel(options: Options = {}) {
  const fake = fakeApi(options.api)
  const folders = fakeBrowse()
  const onCreated = vi.fn()
  const access = fakeFullAccess()
  const shown = fakeBrowser(options.readiness)
  render(<NewWorkspaceDialog t={t} api={fake.api} browse={folders.browse} browser={shown.browser}
    readModels={async () => options.catalog === null ? undefined : options.catalog ?? CATALOG}
    fullAccess={options.fullAccess ?? access.fullAccess} from="sidebar" onClose={vi.fn()} onCreated={onCreated} wait={async () => {}} now={() => NOW} />)
  await settle()
  await click(button(/^New folder/))
  await click(button(en.continue))
  await type(screen.getByLabelText(en['new.name']), 'site')
  await click(button(en.continue))
  await click(button(en.continue))
  return { ...fake, onCreated, askFullAccess: access.ask }
}

/** Go on to the safety screen. */
async function toSafety(options: Options = {}) {
  const mounted = await atModel(options)
  await click(button(en.continue))
  return mounted
}

const SITE = `${HOME}/Projects/site`

describe('the model screen', () => {
  it('is step 4 and opens on the home\'s default model and thinking level', async () => {
    await atModel()
    expect(heading()).toBe('New workspace · Model')
    expect(screen.getByText('Step 4 of 5')).toBeTruthy()
    expect(screen.getByText(en['model.title'])).toBeTruthy()
    expect(shown(modelSelect())).toBe('DeepSeek Pro (your default)')
    expect(shown(thinkingSelect())).toBe('High')
    expect(screen.getByText(en['model.kept'])).toBeTruthy()
  })

  it('groups the models by provider when several are connected', async () => {
    await atModel()
    expect([...modelSelect().querySelectorAll('optgroup')].map(group => group.label)).toEqual(['DeepSeek', 'Other'])
  })

  it('lists the thinking levels of the model chosen, selecting that model\'s own default', async () => {
    await atModel()
    await choose(modelSelect(), '1')
    expect(shown(modelSelect())).toBe('DeepSeek Flash')
    expect([...thinkingSelect().options].map(option => option.textContent)).toEqual(['Off', 'On'])
    expect(shown(thinkingSelect())).toBe('Off')
    await choose(thinkingSelect(), 'on')
    expect(shown(thinkingSelect())).toBe('On')
    await choose(modelSelect(), '0')
    expect(shown(thinkingSelect())).toBe('Low')
  })

  it('disables Thinking for a model without thinking levels', async () => {
    await atModel()
    await choose(modelSelect(), '2')
    expect(thinkingSelect().disabled).toBe(true)
    expect(shown(thinkingSelect())).toBe(en['model.noThinking'])
  })

  it('says the chats start on the home\'s model when the catalogue cannot be read, and still goes on', async () => {
    await atModel({ catalog: null })
    expect(screen.getByText(en['model.unavailable'])).toBeTruthy()
    expect(screen.queryByLabelText(en['model.model'])).toBeNull()
    await click(button(en.continue))
    expect(heading()).toBe('New workspace · Safety')
  })

  it('shows the shared copy block, offers Back and Create now, and goes back to the browser screen', async () => {
    await atModel()
    expect(screen.getByText(en['chats.intro'])).toBeTruthy()
    for (const key of ['chats.model', 'chats.permission', 'chats.network'] as const) expect(screen.getByText(en[key])).toBeTruthy()
    expect(button(en.createNow).disabled).toBe(false)
    await click(button(en.back))
    expect(heading()).toBe('New workspace · Browser')
  })
})

describe('the safety screen', () => {
  it('is the last step, opens on the safe choices and creates with its primary button', async () => {
    await toSafety()
    expect(heading()).toBe('New workspace · Safety')
    expect(screen.getByText('Step 5 of 5')).toBeTruthy()
    expect(radio(en['safety.files.title']).checked).toBe(true)
    expect(radio(en['safety.network.open']).checked).toBe(true)
    expect(button(en.create).disabled).toBe(false)
    expect(screen.queryByRole('button', { name: en.createNow })).toBeNull()
    expect(screen.queryByRole('textbox', { name: en['safety.hosts'] })).toBeNull()
  })

  it('offers two permissions, with Full access noting it asks once, and no Read only', async () => {
    await toSafety()
    expect(screen.getAllByRole('radio').map(each => each.closest('label')?.textContent)).toEqual([
      `${en['safety.files.title']}${en['safety.files.body']}`,
      `${en['safety.full.title']}${en['safety.full.body']}`,
      `${en['safety.network.open']}${en['safety.network.open.body']}`,
      `${en['safety.network.allowlist']}${en['safety.network.allowlist.body']}`,
      `${en['safety.network.off']}${en['safety.network.off.body']}`,
    ])
    expect(en['safety.full.body']).toContain('asks you once for this workspace')
    expect(en['safety.files.body']).toContain('Recommended')
  })

  it('shows the override line and the shared copy block', async () => {
    await toSafety()
    expect(screen.getByText('One chat can still switch to Read only or Full access from the permission menu or /permission.')).toBeTruthy()
    expect(screen.getByText(en['chats.intro'])).toBeTruthy()
    expect(within(screen.getByRole('region', { name: en['chats.intro'] })).getAllByRole('listitem').map(each => each.textContent))
      .toEqual([en['chats.model'], en['chats.permission'], en['chats.network']])
  })

  it('reads the hosts of an allowlist one per line and refuses what is not a host name', async () => {
    await toSafety()
    await click(radio(en['safety.network.allowlist']))
    const hosts = screen.getByRole('textbox', { name: en['safety.hosts'] })
    expect(screen.getByText(en['safety.hostsEmpty'])).toBeTruthy()
    expect(button(en.create).disabled).toBe(true)
    await type(hosts, 'registry.npmjs.org\nhttps://github.com/x')
    expect(screen.getByRole('alert').textContent).toBe('"https://github.com/x" is not a site name. Write one such as registry.npmjs.org or *.npmjs.org.')
    expect(button(en.create).disabled).toBe(true)
    await type(hosts, 'localhost')
    expect(screen.getByRole('alert').textContent).toContain('"localhost"')
    await type(hosts, 'registry.npmjs.org\n*.github.com\ngithub.com:22')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(button(en.create).disabled).toBe(false)
  })

  it('keeps the hosts typed when another access is chosen and back', async () => {
    await toSafety()
    await click(radio(en['safety.network.allowlist']))
    await type(screen.getByRole('textbox', { name: en['safety.hosts'] }), 'pypi.org')
    await click(radio(en['safety.network.off']))
    expect(screen.queryByRole('textbox', { name: en['safety.hosts'] })).toBeNull()
    expect(button(en.create).disabled).toBe(false)
    await click(radio(en['safety.network.allowlist']))
    expect((screen.getByRole('textbox', { name: en['safety.hosts'] }) as HTMLTextAreaElement).value).toBe('pypi.org')
  })

  it('goes back to the model screen with the pick kept', async () => {
    await atModel()
    await choose(modelSelect(), '1')
    await click(button(en.continue))
    await click(button(en.back))
    expect(shown(modelSelect())).toBe('DeepSeek Flash')
  })
})

describe('finishing', () => {
  it('creates now from the model screen with every choice prefilled, storing the home\'s model and sending nothing else', async () => {
    const { create, setDefaults, setNetwork, askFullAccess, onCreated } = await atModel()
    await click(button(en.createNow))
    expect(create).toHaveBeenCalledExactlyOnceWith({ parent: `${HOME}/Projects`, name: 'site', git: true })
    expect(setDefaults).toHaveBeenCalledExactlyOnceWith(SITE, { model: { provider: 'deepseek', model: 'deepseek-pro', reasoningEffort: 'high' }, browser: 'isolated' })
    expect(setNetwork).not.toHaveBeenCalled()
    expect(askFullAccess).not.toHaveBeenCalled()
    expect(onCreated).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'workspace-2', path: SITE, folder: 'code' })
  })

  it('stores the model and level picked, with the canonical path the Host returned', async () => {
    const { setDefaults } = await atModel({ api: { create: async () => ok({ result: 'added', workspaceId: 'workspace-2', path: '/real/site', git: true }) } })
    await choose(modelSelect(), '1')
    await choose(thinkingSelect(), 'on')
    await click(button(en.createNow))
    expect(setDefaults).toHaveBeenCalledExactlyOnceWith('/real/site', { model: { provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'on' }, browser: 'isolated' })
  })

  it('stores a model without thinking levels with no level', async () => {
    const { setDefaults } = await atModel()
    await choose(modelSelect(), '2')
    await click(button(en.createNow))
    expect(setDefaults).toHaveBeenCalledExactlyOnceWith(SITE, { model: { provider: 'other', model: 'plain' }, browser: 'isolated' })
  })

  it('stores only the browser choice when the catalogue could not be read', async () => {
    const { setDefaults, onCreated } = await atModel({ catalog: null })
    await click(button(en.createNow))
    expect(setDefaults).toHaveBeenCalledExactlyOnceWith(SITE, { browser: 'isolated' })
    expect(onCreated).toHaveBeenCalledOnce()
  })

  it('sets up in order: defaults, network, Full access, then reports the workspace', async () => {
    const order: string[] = []
    const access = fakeFullAccess()
    access.ask.mockImplementation(async (path) => { order.push(`ask ${path}`); return true })
    const { onCreated } = await toSafety({
      fullAccess: access.fullAccess,
      api: {
        create: async (request) => { order.push('create'); return ok({ result: 'added', workspaceId: 'workspace-2', path: `${request.parent}/${request.name}`, git: true }) },
        setDefaults: async (_path, defaults) => { order.push('defaults'); return ok({ result: 'defaults', defaults }) },
        setNetwork: async (_path, network) => { order.push('network'); return ok({ network }) },
      },
    })
    onCreated.mockImplementation(() => { order.push('created') })
    await click(radio(en['safety.full.title']))
    await click(radio(en['safety.network.off']))
    await click(button(en.create))
    expect(order).toEqual(['create', 'defaults', 'network', `ask ${SITE}`, 'created'])
  })

  it('shows Setting up… in the footer while the workspace is set up', async () => {
    let release: () => void = () => {}
    const { create } = await atModel({ api: { setDefaults: () => new Promise((resolve) => { release = () => { resolve(ok({ result: 'defaults', defaults: {} })) } }) } })
    await click(button(en.createNow))
    expect(create).toHaveBeenCalledOnce()
    expect(screen.getByRole('status').textContent).toBe(en['setup.working'])
    await act(async () => { release() })
    await settle()
  })

  it('sends a network that is not Open, as the access and its hosts, and nothing for Open', async () => {
    const off = await toSafety()
    await click(radio(en['safety.network.off']))
    await click(button(en.create))
    expect(off.setNetwork).toHaveBeenCalledExactlyOnceWith(SITE, { access: 'off', hosts: [] })
    cleanup()
    const listed = await toSafety()
    await click(radio(en['safety.network.allowlist']))
    await type(screen.getByRole('textbox', { name: en['safety.hosts'] }), ' PyPI.org \nregistry.npmjs.org\npypi.org')
    await click(button(en.create))
    expect(listed.setNetwork).toHaveBeenCalledExactlyOnceWith(SITE, { access: 'allowlist', hosts: ['pypi.org', 'registry.npmjs.org'] })
  })

  it('sends hosts only for an allowlist, though some were typed before another access was chosen', async () => {
    const { setNetwork } = await toSafety()
    await click(radio(en['safety.network.allowlist']))
    await type(screen.getByRole('textbox', { name: en['safety.hosts'] }), 'pypi.org')
    await click(radio(en['safety.network.off']))
    await click(button(en.create))
    expect(setNetwork).toHaveBeenCalledExactlyOnceWith(SITE, { access: 'off', hosts: [] })
  })

  it('does not create from the model screen with an allowlist that is not valid', async () => {
    const { create } = await toSafety()
    await click(radio(en['safety.network.allowlist']))
    await click(button(en.back))
    expect(button(en.createNow).disabled).toBe(true)
    expect(create).not.toHaveBeenCalled()
  })

  it('asks for Full access only when it was chosen, for the workspace the Host returned', async () => {
    const asked = await toSafety()
    await click(button(en.create))
    expect(asked.askFullAccess).not.toHaveBeenCalled()
    cleanup()
    const chosen = await toSafety()
    await click(radio(en['safety.full.title']))
    await click(button(en.create))
    expect(chosen.askFullAccess).toHaveBeenCalledExactlyOnceWith(SITE)
    expect(chosen.onCreated).toHaveBeenCalledOnce()
  })

  it('opens the workspace on Change files when the person declines Full access, without a note', async () => {
    const access = fakeFullAccess(false)
    const { onCreated } = await toSafety({ fullAccess: access.fullAccess })
    await click(radio(en['safety.full.title']))
    await click(button(en.create))
    expect(access.ask).toHaveBeenCalledOnce()
    expect(onCreated).toHaveBeenCalledOnce()
    expect(screen.queryByText(en['done.fullAccess'])).toBeNull()
  })

  it('says to turn Full access on later when the consent service is absent, and opens the workspace when asked', async () => {
    const access = fakeFullAccess(true, false)
    const { onCreated } = await toSafety({ fullAccess: access.fullAccess })
    await click(radio(en['safety.full.title']))
    await click(button(en.create))
    expect(access.ask).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe('Turn Full access on later from the permission menu in a chat.')
    expect(onCreated).not.toHaveBeenCalled()
    await click(button(en['done.open']))
    expect(onCreated).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'workspace-2', path: SITE, folder: 'code' })
  })

  it('treats a consent that cannot be asked like an absent one', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const access = fakeFullAccess()
    access.ask.mockRejectedValue(new Error('no prompt'))
    const { onCreated } = await toSafety({ fullAccess: access.fullAccess })
    await click(radio(en['safety.full.title']))
    await click(button(en.create))
    expect(screen.getByRole('alert').textContent).toBe(en['done.fullAccess'])
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('reports defaults that could not be saved in place, and still opens the workspace', async () => {
    const { onCreated, setNetwork } = await toSafety({ api: { setDefaults: async () => ok({ result: 'failed' }) } })
    await click(radio(en['safety.network.off']))
    await click(button(en.create))
    expect(screen.getByRole('alert').textContent).toBe(en['done.defaults'])
    expect(setNetwork).toHaveBeenCalledOnce()
    expect(onCreated).not.toHaveBeenCalled()
    await click(button(en['done.open']))
    expect(onCreated).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'workspace-2', path: SITE, folder: 'code' })
  })

  it('reports a network that could not be saved in place, and still asks for Full access', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { askFullAccess, onCreated } = await toSafety({ api: { setNetwork: async () => failure('failed') } })
    await click(radio(en['safety.network.off']))
    await click(radio(en['safety.full.title']))
    await click(button(en.create))
    expect(screen.getByRole('alert').textContent).toBe(en['done.network'])
    expect(askFullAccess).toHaveBeenCalledOnce()
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('opens the workspace when the done view is closed', async () => {
    const { onCreated } = await toSafety({ api: { setDefaults: async () => failure('failed') } })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await click(button(en.create))
    await click(button(en.close))
    expect(onCreated).toHaveBeenCalledOnce()
  })

  it('sets nothing up for a recent workspace, which keeps what it has', async () => {
    const fake = fakeApi()
    const onCreated = vi.fn()
    render(<NewWorkspaceDialog t={t} api={fake.api} browse={fakeBrowse().browse} readModels={async () => CATALOG} fullAccess={fakeFullAccess().fullAccess} browser={fakeBrowser().browser}
      from="sidebar" onClose={vi.fn()} onCreated={onCreated} now={() => NOW} />)
    await settle()
    await click(screen.getByRole('button', { name: /^delorun/ }))
    expect(fake.add).toHaveBeenCalledOnce()
    expect(fake.setDefaults).not.toHaveBeenCalled()
    expect(onCreated).toHaveBeenCalledOnce()
  })
})
