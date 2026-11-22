// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_BUNDLES, AGENTS_GUIDE_URL, AgentsStep } from '../src/client/steps/Agents.tsx'
import { LookStep } from '../src/client/steps/Look.tsx'
import { connectionName, PluginsStep, readableName } from '../src/client/steps/Plugins.tsx'
import { APPROVE_COMMAND, REACH_COMMAND, ReachStep } from '../src/client/steps/Reach.tsx'
import { BreakablePath } from '../src/client/ui/BreakablePath.tsx'
import { keepSignInTogether } from '../src/client/steps/shared.ts'
import { ReadyStep } from '../src/client/steps/Ready.tsx'
import { WelcomeStep } from '../src/client/steps/Welcome.tsx'
import { CommandRow as Command } from '../src/client/ui/CommandRow.tsx'
import { createGuide, type Guide } from '../src/client/guide.ts'
import { en, zh } from '../src/client/locales.ts'
import { STOCK_OFF } from '../src/client/steps/StockLook.tsx'
import { ACCENT_PRESETS, PALETTE_CHOICES } from '../src/client/previews.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { TAILSCALE_OPERATOR_COMMAND } from '@delorun/contract-reach-providers'
import type { Readiness, TailscaleReadiness } from '../src/wire.ts'
import { agentsFake, DEFAULT_PATH, DEFAULT_WORKSPACE, hostFake, installerFake, KEYS, languageFace, liveForm, LOCALES, noticeFace, READY, schemeFace, stepServices, THEME } from './fixtures.client.ts'
import type { HostFace, StartTarget, StepServices } from '../src/client/types.ts'
import type { ThemeSettings } from '@delorun/plugin-theme'

afterEach(cleanup)

const click = async (element: HTMLElement) => { await act(async () => { fireEvent.click(element) }) }
const radio = (name: string | RegExp) => screen.getByRole('radio', { name })
const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }

/** A guide over a faked harness, its reads settled once the component renders. */
const guideOf = (host: HostFace = hostFake().host): Guide => createGuide(host)

/** Render the look step, whose guide is unused. */
const look = (services: StepServices, guide: Guide = guideOf(), next: () => void = () => {}) => render(<LookStep services={services} guide={guide} next={next} />)

describe('the look step', () => {
  it('offers light, dark and system and sets the colour scheme', async () => {
    const { face, set } = schemeFace('system')
    look(stepServices({ scheme: face }))
    const group = screen.getByRole('radiogroup', { name: 'Mode' })
    expect(within(group).getAllByRole('radio').map(each => [each.textContent, each.getAttribute('aria-checked')])).toEqual([['Light', 'false'], ['Dark', 'false'], ['System', 'true']])
    await click(radio('Dark'))
    expect(set).toHaveBeenCalledWith('dark')
  })

  it('shows every palette the theme has as a chip with its preview and writes the one chosen', async () => {
    const services = stepServices()
    look(services)
    const group = screen.getByRole('radiogroup', { name: 'Theme' })
    const chips = within(group).getAllByRole('radio')
    expect(chips.map(each => each.textContent)).toEqual(['Soft', 'T3 Code', 'T3 Chat', 'Grove', 'Ocean', 'Ember', 'Iris', 'Custom'])
    expect(PALETTE_CHOICES).toHaveLength(chips.length - 1)
    expect(chips.every(each => each.querySelector('[aria-hidden="true"]') !== null)).toBe(true)
    expect(radio('Soft').getAttribute('aria-checked')).toBe('true')
    await click(radio('Soft'))
    expect(services.look.settings.getSnapshot().value?.palette).toBe('soft')
    await click(radio('Iris'))
    expect(services.look.settings.getSnapshot().value?.palette).toBe('iris')
    expect(radio('Iris').getAttribute('aria-checked')).toBe('true')
  })

  it('starts on the palette and mode saved in Settings when setup runs again, not on the defaults', () => {
    const { face } = schemeFace('dark')
    const services = stepServices({ scheme: face })
    void services.look.settings.set('palette', 'ocean')
    look(services)
    expect(radio('Ocean').getAttribute('aria-checked')).toBe('true')
    expect(radio('Soft').getAttribute('aria-checked')).toBe('false')
    expect(radio('Dark').getAttribute('aria-checked')).toBe('true')
  })

  it('shows no accent picker for a preset, and reveals it with the custom values written together when Custom is chosen', async () => {
    const services = stepServices()
    look(services)
    expect(screen.queryByRole('radiogroup', { name: 'Accent' })).toBeNull()
    await click(radio('Grove'))
    expect(screen.queryByRole('radiogroup', { name: 'Accent' })).toBeNull()
    await click(radio('Custom'))
    const group = screen.getByRole('radiogroup', { name: 'Accent' })
    expect(within(group).getAllByRole('radio').map(each => each.textContent)).toEqual(['Peach', 'Cobalt', 'Moss', 'Mono', 'Custom'])
    expect(ACCENT_PRESETS).toHaveLength(4)
    // Grove's accent seeds the free colour.
    expect(services.look.settings.getSnapshot().value).toMatchObject({ palette: 'custom', accent: 'custom', customAccent: '#1B7D50', contrast: 100 })
    await click(radio('Cobalt'))
    expect(services.look.settings.getSnapshot().value).toMatchObject({ palette: 'custom', accent: 'cobalt' })
    const hex = screen.getByLabelText<HTMLInputElement>('Hex colour')
    fireEvent.change(hex, { target: { value: '#12ab34' } })
    await act(async () => { fireEvent.blur(hex) })
    expect(services.look.settings.getSnapshot().value).toMatchObject({ palette: 'custom', accent: 'custom', customAccent: '#12AB34' })
    await click(radio('Iris'))
    expect(screen.queryByRole('radiogroup', { name: 'Accent' })).toBeNull()
  })

  it('reads a preset stored beside a changed accent as Custom', () => {
    look(stepServices({ look: { settings: liveForm<ThemeSettings>({ ...THEME, accent: 'moss' }).form, useStockLook: () => Promise.resolve(true) } }))
    expect(within(screen.getByRole('radiogroup', { name: 'Theme' })).getByRole('radio', { name: 'Custom' }).getAttribute('aria-checked')).toBe('true')
    expect(radio('Moss').getAttribute('aria-checked')).toBe('true')
  })

  it('moves between the theme tiles with the arrow keys', async () => {
    const services = stepServices()
    look(services)
    radio('Soft').focus()
    await act(async () => { fireEvent.keyDown(radio('Soft'), { key: 'ArrowRight' }) })
    expect(document.activeElement).toBe(radio('T3 Code'))
    expect(services.look.settings.getSnapshot().value?.palette).toBe('t3-code')
  })

  it('starts from Soft and Peach until the theme settings arrive, and disables the choices it cannot save', () => {
    const waiting = liveForm<ThemeSettings>(undefined, { writable: false })
    look(stepServices({ look: { settings: waiting.form, useStockLook: () => Promise.resolve(true) } }))
    expect(radio('Soft').getAttribute('aria-checked')).toBe('true')
    expect(radio('Iris').hasAttribute('disabled')).toBe(true)
    expect((radio('Dark') as HTMLButtonElement).disabled).toBe(false)
  })

  it('offers the original look as one quiet link, and opens its screen in place of the step without changing anything', async () => {
    const useStockLook = vi.fn(() => Promise.resolve(true))
    const guide = guideOf()
    look(stepServices({ look: { settings: liveForm<ThemeSettings>(THEME).form, useStockLook } }), guide)
    expect(screen.getByText(en['look.stock.ask'], { exact: false })).toBeTruthy()
    expect(screen.queryByText(en['look.stock.sure'])).toBeNull()
    await click(screen.getByRole('button', { name: en['look.stock.open'] }))
    expect(screen.getByText(en['look.stock.sure'])).toBeTruthy()
    expect(screen.queryByRole('radiogroup', { name: 'Theme' })).toBeNull()
    expect(screen.getAllByRole('listitem')).toHaveLength(STOCK_OFF.length)
    expect(useStockLook).not.toHaveBeenCalled()
    expect(guide.stock.getSnapshot()).toBe(false)
  })

  it('returns to the Look step with nothing chosen when the screen is cancelled, by Keep or by Back', async () => {
    const guide = guideOf()
    const next = vi.fn()
    look(stepServices(), guide, next)
    await click(screen.getByRole('button', { name: en['look.stock.open'] }))
    await click(screen.getByRole('button', { name: en['look.stock.no'] }))
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeTruthy()
    expect(guide.stock.getSnapshot()).toBe(false)
    await click(screen.getByRole('button', { name: en['look.stock.open'] }))
    await click(screen.getByRole('button', { name: en['look.stock.back'] }))
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeTruthy()
    expect(next).not.toHaveBeenCalled()
  })

  it('records the choice and goes on to the next step when the screen is confirmed, without changing the look', async () => {
    const useStockLook = vi.fn(() => Promise.resolve(true))
    const guide = guideOf()
    const next = vi.fn()
    look(stepServices({ look: { settings: liveForm<ThemeSettings>(THEME).form, useStockLook } }), guide, next)
    await click(screen.getByRole('button', { name: en['look.stock.open'] }))
    await click(screen.getByRole('button', { name: en['look.stock.yes'] }))
    expect(guide.stock.getSnapshot()).toBe(true)
    expect(next).toHaveBeenCalledOnce()
    expect(useStockLook).not.toHaveBeenCalled()
    expect(screen.getByText(en['look.stock.chosen'], { exact: false })).toBeTruthy()
    await click(screen.getByRole('button', { name: en['look.stock.change'] }))
    await click(screen.getByRole('button', { name: en['look.stock.no'] }))
    expect(guide.stock.getSnapshot()).toBe(false)
  })

  it('has the screen\'s copy in English and Chinese', () => {
    const keys = Object.keys(en).filter(key => key.startsWith('look.stock.') || key === 'ready.stock')
    expect(keys.length).toBeGreaterThan(20)
    for (const key of keys) expect(zh[key as keyof typeof zh], key).toBeTruthy()
  })

  it('shows a compact sample drawn in the chosen look beside the choices', () => {
    look(stepServices())
    const preview = screen.getByRole('img', { name: en['look.preview'] })
    expect(preview.textContent).toContain(en['look.preview.ask'])
    expect(preview.textContent).toContain(en['look.preview.box'])
  })

  it.each<readonly [string, boolean | 'reject', string]>([
    ['refuses a palette', false, 'Iris'],
    ['cannot be reached for a palette', 'reject', 'Iris'],
    ['refuses Custom', false, 'Custom'],
    ['cannot be reached for Custom', 'reject', 'Custom'],
  ])('shows a failure when the host %s', async (_, result, choice) => {
    const form = liveForm<ThemeSettings>(THEME, { result })
    look(stepServices({ look: { settings: form.form, useStockLook: () => Promise.resolve(true) } }))
    await click(radio(choice))
    expect(screen.getByRole('alert').textContent).toBe(en.saveFailed)
  })

  it('clears a failure on the next attempt', async () => {
    const form = liveForm<ThemeSettings>(THEME, { result: false })
    look(stepServices({ look: { settings: form.form, useStockLook: () => Promise.resolve(true) } }))
    await click(radio('Iris'))
    expect(screen.getByRole('alert')).toBeTruthy()
    form.set.mockImplementationOnce(() => Promise.resolve(true))
    await click(radio('Ocean'))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('the welcome step', () => {
  it('lists the languages as large tiles, each named in its own language, and switches the interface language when one is chosen', async () => {
    const { face, setLocale } = languageFace()
    render(<WelcomeStep services={stepServices({ language: face })} guide={guideOf()} notice={undefined} />)
    const group = screen.getByRole('radiogroup', { name: en['welcome.language'] })
    expect(within(group).getAllByRole('radio').map(each => [each.textContent, each.getAttribute('aria-checked')])).toEqual([
      [`English${en['welcome.language.own']}`, 'true'], [`中文${zh['welcome.language.own']}`, 'false'],
    ])
    await click(radio(zh['welcome.language.own']))
    expect(setLocale).toHaveBeenCalledWith('zh')
    expect(radio(zh['welcome.language.own']).getAttribute('aria-checked')).toBe('true')
  })

  it('draws the studio in miniature in the active language', () => {
    render(<WelcomeStep services={stepServices()} guide={guideOf()} notice={undefined} />)
    const picture = screen.getByRole('img', { name: en['welcome.preview'] })
    for (const key of ['welcome.preview.newChat', 'welcome.preview.today', 'welcome.preview.chat.1', 'look.preview.answer', 'look.preview.box'] as const) {
      expect(within(picture).getByText(en[key])).toBeTruthy()
    }
  })

  it('shows the preview notice\'s title and paragraphs while it is owed, and nothing of it otherwise', () => {
    const { face } = noticeFace()
    render(<WelcomeStep services={stepServices()} guide={guideOf()} notice={face} />)
    expect(screen.getByRole('heading', { level: 3, name: 'Preview' })).toBeTruthy()
    expect(screen.getAllByText(/Delorun is a pre-release|no telemetry/)).toHaveLength(2)
    cleanup()
    render(<WelcomeStep services={stepServices()} guide={guideOf()} notice={undefined} />)
    expect(screen.queryByText(/Delorun is a pre-release/)).toBeNull()
  })
})

describe('the welcome step on a studio with device access', () => {
  it('names the address as copyable text only when one is given', () => {
    render(<WelcomeStep services={stepServices()} guide={guideOf()} notice={undefined} deviceAddress="https://my-pc.example.ts.net" />)
    expect(screen.getByText(en['welcome.devices'], { exact: false }).textContent).toBe(`${en['welcome.devices']} https://my-pc.example.ts.net`)
    expect(screen.getByText('https://my-pc.example.ts.net').tagName).toBe('CODE')
    cleanup()
    render(<WelcomeStep services={stepServices()} guide={guideOf()} notice={undefined} />)
    expect(screen.queryByText(en['welcome.devices'], { exact: false })).toBeNull()
  })
})

describe('a command', () => {
  it('copies itself and says so, or says to copy it by hand when the clipboard refuses', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<Command command="tailscale up" t={stepServices().t} />)
    expect(screen.getByText('tailscale up').tagName).toBe('CODE')
    await click(screen.getByRole('button', { name: 'Copy tailscale up' }))
    expect(writeText).toHaveBeenCalledWith('tailscale up')
    expect(screen.getByText(en['copy.done'])).toBeTruthy()
    writeText.mockImplementationOnce(() => Promise.reject(new Error('denied')))
    await click(screen.getByRole('button', { name: 'Copy tailscale up' }))
    expect(screen.getByText(en['copy.failed'])).toBeTruthy()
  })
})

describe('the agents step', () => {
  it('reads where the two bundles stand when it opens and installs nothing', () => {
    const services = stepServices()
    render(<AgentsStep services={services} guide={guideOf()} />)
    expect(services.spies.refresh).toHaveBeenCalledWith(AGENT_BUNDLES.map(each => each.name))
    expect(services.spies.install).not.toHaveBeenCalled()
    expect(AGENT_BUNDLES.map(each => each.name)).toEqual(['@deepseek-ai/dsh-subagent-claude-code', '@deepseek-ai/dsh-subagent-codex'])
    expect(screen.getAllByRole('heading', { level: 4 }).map(each => each.textContent)).toEqual(['Claude Code', 'Codex'])
  })

  it.each<readonly [string, Readiness | undefined, readonly [string, string]]>([
    ['both signed in', READY, [en['agents.claude.signIn.found'], en['agents.codex.signIn.found']]],
    ['neither signed in', { ...READY, agents: { 'claude-code': 'missing', 'codex': 'missing' } }, [en['agents.claude.signIn.missing'], en['agents.codex.signIn.missing']]],
    ['sign-ins Delorun cannot see', { ...READY, agents: { 'claude-code': 'unknown', 'codex': 'unknown' } }, [en['agents.claude.signIn.unknown'], en['agents.codex.signIn.unknown']]],
    ['a computer that could not be read', undefined, [en['agents.signIn.unread'], en['agents.signIn.unread']]],
  ])('says where each sign-in stands for %s', async (_, readiness, lines) => {
    const [claude, codex] = AGENT_BUNDLES
    const fake = installerFake({ [claude.name]: { state: 'available' }, [codex.name]: { state: 'available' } })
    render(<AgentsStep services={stepServices({ bundles: fake.installer })} guide={guideOf(hostFake({ readiness }).host)} />)
    expect(screen.getAllByText(en['agents.signIn.checking'])).toHaveLength(2)
    await settle()
    for (const line of lines) expect(screen.getAllByText(line).length).toBeGreaterThan(0)
  })

  it.each<readonly [string, 'checking' | 'failed' | 'unavailable']>([
    ['is being checked', 'checking'],
    ['could not be added', 'failed'],
    ['is not included', 'unavailable'],
  ])('shows one state at a time while a bundle %s: no sign-in line beside it', async (_, state) => {
    const [claude] = AGENT_BUNDLES
    const fake = installerFake({ [claude.name]: { state } })
    render(<AgentsStep services={stepServices({ bundles: fake.installer })} guide={guideOf(hostFake({ readiness: READY }).host)} />)
    await settle()
    const card = screen.getByRole('heading', { level: 4, name: 'Claude Code' }).closest('li') as HTMLElement
    expect(within(card).queryByText(en['agents.claude.signIn.found'])).toBeNull()
    expect(within(card).queryByText(en['agents.signIn.checking'])).toBeNull()
  })

  it.each(['installing', 'slow'] as const)('keeps the sign-in line and the download size while the agent is %s', async (state) => {
    const [claude] = AGENT_BUNDLES
    const fake = installerFake({ [claude.name]: { state } })
    render(<AgentsStep services={stepServices({ bundles: fake.installer })} guide={guideOf(hostFake({ readiness: READY }).host)} />)
    await settle()
    const card = screen.getByRole('heading', { level: 4, name: 'Claude Code' }).closest('li') as HTMLElement
    expect(within(card).getByText(en['agents.claude.signIn.found'])).toBeTruthy()
    expect(within(card).getByText('Downloads about 206 MB when you add it.')).toBeTruthy()
  })

  it('shows the slow state as still working, and a failure with the plugin manager\'s reason and the download size', () => {
    const [claude, codex] = AGENT_BUNDLES
    const fake = installerFake({ [claude.name]: { state: 'slow' }, [codex.name]: { state: 'failed', reason: 'disk full' } })
    render(<AgentsStep services={stepServices({ bundles: fake.installer })} guide={guideOf()} />)
    expect(screen.getByText(en['bundle.slow'])).toBeTruthy()
    expect(screen.getByText('Could not add it: disk full. Try again, or add it from Plugins.')).toBeTruthy()
    expect(screen.getByText('Downloads about 320 MB when you add it.')).toBeTruthy()
  })

  it('shows the default path on each card: how a chat uses the agent, the risk warning and one Add, with no choice', async () => {
    const [claude, codex] = AGENT_BUNDLES
    const fake = installerFake({ [claude.name]: { state: 'available' }, [codex.name]: { state: 'available' } })
    render(<AgentsStep services={stepServices({ bundles: fake.installer })} guide={guideOf()} />)
    const cardOf = (title: string): HTMLElement => screen.getByRole('heading', { level: 4, name: title }).closest('li') as HTMLElement
    const claudeCard = cardOf('Claude Code')
    const codexCard = cardOf('Codex')
    expect(within(claudeCard).getByText(keepSignInTogether(en['agents.claude.how']), { exact: false })).toBeTruthy()
    expect(within(codexCard).getByText(keepSignInTogether(en['agents.codex.how']), { exact: false })).toBeTruthy()
    // The rest of the permissions copy is folded under a disclosure until it is opened, with its copy kept.
    for (const [card, key] of [[claudeCard, 'claude'], [codexCard, 'codex']] as const) {
      expect(within(card).queryByText(keepSignInTogether(en[`agents.${key}.permissions`]), { exact: false })).toBeNull()
    }
    await click(within(claudeCard).getByRole('button', { name: en['agents.permissions'] }))
    expect(within(claudeCard).getByText(en['agents.claude.permissions'], { exact: false })).toBeTruthy()
    expect(within(claudeCard).getByText('Downloads about 206 MB when you add it.')).toBeTruthy()
    expect(within(codexCard).getByText('Downloads about 320 MB when you add it.')).toBeTruthy()
    expect(within(claudeCard).getByText(en['agents.claude.risk'])).toBeTruthy()
    expect(within(codexCard).getByText(en['agents.codex.risk'])).toBeTruthy()
    // Only Claude Code recommends a home connection.
    expect(en['agents.claude.risk']).toContain('A home internet connection works best; avoid VPNs, proxies and cloud servers.')
    expect(within(codexCard).queryByText(/home internet/)).toBeNull()
    for (const card of [claudeCard, codexCard]) {
      expect(within(card).getAllByRole('button').map(each => each.textContent)).toEqual([en['bundle.add'], en['agents.permissions'], en['agents.advanced']])
      expect(within(card).getByRole('button', { name: en['agents.advanced'] }).getAttribute('aria-expanded')).toBe('false')
      expect(within(card).queryByRole('radio')).toBeNull()
      expect(within(card).getByRole('link', { name: en['agents.guide'] }).getAttribute('href')).toBe(AGENTS_GUIDE_URL)
    }
  })

  it('shows the sign-in command with a copy button, not a sentence to follow, when an agent is not signed in', async () => {
    const [claude, codex] = AGENT_BUNDLES
    const fake = installerFake({ [claude.name]: { state: 'available' }, [codex.name]: { state: 'installed' } })
    render(<AgentsStep services={stepServices({ bundles: fake.installer })} guide={guideOf(hostFake({ readiness: { ...READY, agents: { 'claude-code': 'missing', 'codex': 'missing' } } }).host)} />)
    await settle()
    const cardOf = (title: string): HTMLElement => screen.getByRole('heading', { level: 4, name: title }).closest('li') as HTMLElement
    expect(within(cardOf('Claude Code')).getByText('delorun agents login claude-code')).toBeTruthy()
    expect(within(cardOf('Codex')).getByText('delorun agents login codex')).toBeTruthy()
    expect(within(cardOf('Codex')).getByRole('button', { name: 'Copy delorun agents login codex' })).toBeTruthy()
  })

  it('shows no sign-in command when the agent is signed in', async () => {
    const [claude] = AGENT_BUNDLES
    const fake = installerFake({ [claude.name]: { state: 'installed' } })
    render(<AgentsStep services={stepServices({ bundles: fake.installer })} guide={guideOf(hostFake({ readiness: READY }).host)} />)
    await settle()
    expect(screen.queryByText(/delorun agents login/)).toBeNull()
  })

  it('adds an agent with one press and asks nothing more', async () => {
    const [claude, codex] = AGENT_BUNDLES
    const fake = installerFake({ [claude.name]: { state: 'available' }, [codex.name]: { state: 'available' } })
    render(<AgentsStep services={stepServices({ bundles: fake.installer })} guide={guideOf()} />)
    const adds = screen.getAllByRole('button', { name: /^Add / })
    expect(adds.map(each => [each.getAttribute('aria-label'), each.textContent])).toEqual([['Add Claude Code', en['bundle.add']], ['Add Codex', en['bundle.add']]])
    await click(screen.getByRole('button', { name: 'Add Codex' }))
    expect(fake.install).toHaveBeenCalledExactlyOnceWith(codex.name)
    expect(screen.queryByRole('group')).toBeNull()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('does not hold Continue back for an agent: nothing is left to confirm', async () => {
    const [claude] = AGENT_BUNDLES
    const fake = installerFake({ [claude.name]: { state: 'available' } })
    const guide = guideOf()
    render(<AgentsStep services={stepServices({ bundles: fake.installer })} guide={guide} />)
    await click(screen.getByRole('button', { name: 'Add Claude Code' }))
    expect(await guide.passGates()).toBe(true)
  })

  describe('advanced options', () => {
    const open = async (title: string): Promise<HTMLElement> => {
      const card = screen.getByRole('heading', { level: 4, name: title }).closest('li') as HTMLElement
      await click(within(card).getByRole('button', { name: en['agents.advanced'] }))
      return card
    }
    const available = (): ReturnType<typeof installerFake> => installerFake({ [AGENT_BUNDLES[0].name]: { state: 'available' }, [AGENT_BUNDLES[1].name]: { state: 'available' } })
    const added = (): ReturnType<typeof installerFake> => installerFake({ [AGENT_BUNDLES[0].name]: { state: 'installed' }, [AGENT_BUNDLES[1].name]: { state: 'installed' } })

    it('stays closed on the default path: no model list and no time limit until it is opened', () => {
      render(<AgentsStep services={stepServices({ bundles: available().installer })} guide={guideOf()} />)
      for (const button of screen.getAllByRole('button', { name: en['agents.advanced'] })) expect(button.getAttribute('aria-expanded')).toBe('false')
      expect(screen.queryByRole('radio')).toBeNull()
      expect(screen.queryByRole('spinbutton')).toBeNull()
    })

    it('offers only the agent\'s own default before the agent is added, with a line that the list comes later', async () => {
      const agents = agentsFake({ rows: false })
      const host = hostFake()
      render(<AgentsStep services={stepServices({ bundles: available().installer, agents: agents.face, host: host.host })} guide={guideOf()} />)
      const card = await open('Codex')
      expect(within(card).getAllByRole('radio', { name: en['agents.model.default'] })).toHaveLength(1)
      expect(within(card).getByText('The list of models appears once Codex is added.')).toBeTruthy()
      expect(host.agentModels).not.toHaveBeenCalled()
    })

    it('lists the models the installed agent reports after the default and writes the one chosen', async () => {
      const agents = agentsFake()
      const host = hostFake({ agentModels: { state: 'listed', models: [{ model: 'gpt-codex', displayName: 'GPT Codex' }, { model: 'gpt-mini', displayName: 'GPT Mini' }] } })
      render(<AgentsStep services={stepServices({ bundles: added().installer, agents: agents.face, host: host.host })} guide={guideOf()} />)
      const card = await open('Codex')
      await settle()
      expect(host.agentModels).toHaveBeenCalledExactlyOnceWith('codex')
      const radios = within(within(card).getByRole('radiogroup', { name: en['agents.model.label'] })).getAllByRole('radio')
      expect(radios.map(each => each.parentElement?.textContent)).toEqual([en['agents.model.default'], 'GPT Codex', 'GPT Mini'])
      await click(within(card).getByRole('radio', { name: 'GPT Mini' }))
      expect(agents.codex.set).toHaveBeenCalledExactlyOnceWith('model', 'gpt-mini')
      await click(within(card).getByRole('radio', { name: en['agents.model.default'] }))
      expect(agents.codex.unset).toHaveBeenCalledExactlyOnceWith('model')
    })

    it('says so briefly, with the default still chosen, when the agent cannot list its models', async () => {
      const agents = agentsFake()
      const host = hostFake({ agentModels: { state: 'unavailable', reason: 'failed' } })
      render(<AgentsStep services={stepServices({ bundles: added().installer, agents: agents.face, host: host.host })} guide={guideOf()} />)
      const card = await open('Claude Code')
      await settle()
      expect(within(card).getByText('Claude Code could not list its models, so the default is used.')).toBeTruthy()
      expect(within(card).getByRole('button', { name: en['agents.model.retry'] })).toBeTruthy()
      expect(within(card).queryByRole('alert')).toBeNull()
      expect((within(card).getByRole('radio', { name: en['agents.model.default'] }) as HTMLInputElement).checked).toBe(true)
    })

    it('asks again while the added agent has not registered, then lists its models, and Try again asks at once', async () => {
      vi.useFakeTimers()
      try {
        const agents = agentsFake()
        const host = hostFake({ agentModels: { state: 'unavailable', reason: 'not-running' } })
        render(<AgentsStep services={stepServices({ bundles: added().installer, agents: agents.face, host: host.host })} guide={guideOf()} />)
        const card = await open('Codex')
        await settle()
        expect(within(card).getByText('Codex is not running yet. It starts a moment after it is added.')).toBeTruthy()
        host.agentModels.mockResolvedValue({ state: 'listed', models: [{ model: 'gpt-codex', displayName: 'GPT Codex' }] })
        await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
        expect(within(card).getByRole('radio', { name: 'GPT Codex' })).toBeTruthy()
      } finally { vi.useRealTimers() }
    })

    it('writes the run time limit only as a whole number of minutes in range', async () => {
      const agents = agentsFake()
      render(<AgentsStep services={stepServices({ bundles: available().installer, agents: agents.face })} guide={guideOf()} />)
      const card = await open('Claude Code')
      const field = within(card).getByRole('spinbutton', { name: en['agents.limit.label'] })
      fireEvent.change(field, { target: { value: '0' } })
      fireEvent.keyDown(field, { key: 'Enter' })
      expect(agents.limit.set).not.toHaveBeenCalled()
      fireEvent.change(field, { target: { value: '45' } })
      fireEvent.keyDown(field, { key: 'Enter' })
      expect(agents.limit.set).toHaveBeenCalledExactlyOnceWith('runTimeoutMinutes', 45)
    })
  })

  it.each<readonly [string, 'checking' | 'installing' | 'installed' | 'restart' | 'unavailable' | 'failed', string]>([
    ['is being checked', 'checking', en['bundle.checking']],
    ['is being added', 'installing', en['bundle.adding']],
    ['is added', 'installed', en['bundle.added']],
    ['is added but waits for a restart', 'restart', en['bundle.restart']],
    ['cannot run on this kind of computer', 'unavailable', en['bundle.unavailable']],
    ['could not be added', 'failed', en['bundle.failed']],
  ])('shows the state of a bundle that %s and no Add button', (_, state, text) => {
    const [claude] = AGENT_BUNDLES
    const fake = installerFake({ [claude.name]: { state } })
    render(<AgentsStep services={stepServices({ bundles: fake.installer })} guide={guideOf()} />)
    expect(screen.getAllByText(text).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: /^Add/ })).toBeNull()
  })

  it('shows a bundle this kind of computer cannot run as a normal state, never as an error or a missing download', async () => {
    const [claude, codex] = AGENT_BUNDLES
    const fake = installerFake({ [claude.name]: { state: 'unavailable' }, [codex.name]: { state: 'unavailable' } })
    render(<AgentsStep services={stepServices({ bundles: fake.installer })} guide={guideOf()} />)
    expect(screen.getAllByText(en['bundle.unavailable'])).toHaveLength(2)
    // No sign-in line beside "Not included": the two would read as a contradiction.
    await settle()
    expect(screen.queryByText(en['agents.claude.signIn.found'])).toBeNull()
    expect(screen.queryByText(en['agents.signIn.checking'])).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open Plugins' })).toBeNull()
    expect(fake.openPlugins).not.toHaveBeenCalled()
  })

  it('shows a bundle that failed to be added as an error under the card with a retry', async () => {
    const [claude] = AGENT_BUNDLES
    const fake = installerFake({ [claude.name]: { state: 'failed' } })
    render(<AgentsStep services={stepServices({ bundles: fake.installer })} guide={guideOf()} />)
    expect(within(screen.getByRole('alert')).getByText(en['bundle.failed'])).toBeTruthy()
    await click(screen.getByRole('button', { name: en['bundle.retry'] }))
    expect(fake.install).toHaveBeenCalledExactlyOnceWith(claude.name)
  })
})

describe('the recommended plugins step offers bundled rows', () => {
  const optionalRows = ['delorun-thinking-rsvp', 'delorun-cost-meter']
  const views = {
    'delorun-thinking-rsvp': { state: 'available' as const, title: 'Thinking tab', description: 'Read the reasoning word by word.' },
    'delorun-cost-meter': { state: 'available' as const, title: 'Cost meter', description: 'See what a chat costs.' },
  }

  it('lists both rows off with their own title and description, and reads them once', async () => {
    const fake = installerFake({}, views)
    render(<PluginsStep services={stepServices({ bundles: fake.installer, optionalRows })} guide={guideOf()} />)
    await settle()
    expect(fake.refreshRows).toHaveBeenCalledExactlyOnceWith(optionalRows)
    expect(screen.getAllByRole('heading', { level: 4 }).map(each => each.textContent)).toEqual(['Thinking tab', 'Cost meter'])
    expect(screen.getAllByRole('button', { name: /^Add / }).map(each => each.getAttribute('aria-label'))).toEqual(['Add Thinking tab', 'Add Cost meter'])
    expect(screen.queryByText(en['plugins.none'])).toBeNull()
    expect(fake.enableRow).not.toHaveBeenCalled()
  })

  it('turns on the row whose button is pressed, and no other', async () => {
    const fake = installerFake({}, views)
    render(<PluginsStep services={stepServices({ bundles: fake.installer, optionalRows })} guide={guideOf()} />)
    await click(screen.getByRole('button', { name: 'Add Cost meter' }))
    expect(fake.enableRow).toHaveBeenCalledExactlyOnceWith('delorun-cost-meter')
    expect(fake.install).not.toHaveBeenCalled()
  })

  it.each<readonly [string, 'checking' | 'installing' | 'installed' | 'restart' | 'unavailable' | 'failed', string]>([
    ['is being checked', 'checking', en['bundle.checking']],
    ['is being turned on', 'installing', en['bundle.adding']],
    ['is on', 'installed', en['bundle.added']],
    ['is on but waits for a restart', 'restart', en['bundle.restart']],
    ['is not part of this profile', 'unavailable', en['bundle.unavailable']],
    ['cannot be changed', 'failed', en['bundle.failed']],
  ])('shows a row that %s and no Add button', (_, state, text) => {
    const fake = installerFake({}, { 'delorun-cost-meter': { state, title: 'Cost meter' } })
    render(<PluginsStep services={stepServices({ bundles: fake.installer, optionalRows: ['delorun-cost-meter'] })} guide={guideOf()} />)
    expect(screen.getByText(text)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Add / })).toBeNull()
  })
})

describe('the recommended plugins step', () => {
  const plugins = ['@scope/codex-quota', '@scope/any', '@scope/claude-only', '@scope/unread']

  it('reads the connections once, lists the plugins that fit first with what they fit, and leaves out one for a connection the person lacks', async () => {
    const fake = installerFake({
      '@scope/any': { state: 'available', title: { en: 'Any', zh: '任意' }, description: 'Fits any setup.' },
      '@scope/codex-quota': { state: 'available' },
      '@scope/unread': { state: 'available' },
    })
    const host = hostFake({
      readiness: { ...READY, agents: { 'claude-code': 'missing', 'codex': 'found' } },
      recommend: { plugins: [
        { name: '@scope/codex-quota', connections: ['agent:codex', 'provider:deepseek-official'], source: 'installed' },
        { name: '@scope/any', connections: [], source: 'installed' },
        { name: '@scope/claude-only', connections: ['agent:claude-code'], source: 'installed' },
        { name: '@scope/unread', connections: [], source: 'unknown' },
      ], registry: 'not-asked' },
    })
    const guide = guideOf(host.host)
    render(<PluginsStep services={stepServices({ bundles: fake.installer, plugins })} guide={guide} />)
    expect(screen.getByText(en['plugins.reading'])).toBeTruthy()
    await settle()
    expect(host.recommend).toHaveBeenCalledExactlyOnceWith(false)
    expect(screen.getAllByRole('heading', { level: 4 }).map(each => each.textContent)).toEqual(['Codex quota', 'Any', 'Unread'])
    expect(screen.getByText('Fits Codex, DeepSeek')).toBeTruthy()
    expect(screen.getByText('Fits any setup.')).toBeTruthy()
    expect(fake.refresh).toHaveBeenLastCalledWith(['@scope/codex-quota', '@scope/any', '@scope/unread'])
    await click(screen.getByRole('button', { name: 'Add Any' }))
    expect(fake.install).toHaveBeenCalledWith('@scope/any')
    cleanup()
    render(<PluginsStep services={stepServices({ plugins })} guide={guide} />)
    expect(host.recommend).toHaveBeenCalledOnce()
  })

  it('reads plugins that are not installed from the registry only when asked, and says when it could not be reached', async () => {
    const host = hostFake({ recommend: { plugins: [{ name: '@scope/unread', connections: [], source: 'unknown' }], registry: 'not-asked' } })
    render(<PluginsStep services={stepServices({ plugins: ['@scope/unread'] })} guide={guideOf(host.host)} />)
    await settle()
    host.recommend.mockImplementationOnce(() => Promise.resolve({ plugins: [{ name: '@scope/unread', connections: [], source: 'unknown' }], registry: 'unreachable' }))
    await click(screen.getByRole('button', { name: en['plugins.registry'] }))
    await settle()
    expect(host.recommend).toHaveBeenLastCalledWith(true)
    expect(screen.getByText(en['plugins.registry.unreachable'])).toBeTruthy()
    expect(screen.queryByRole('button', { name: en['plugins.registry'] })).toBeNull()
  })

  it('says so when no recommended plugin fits the person\'s connections', async () => {
    const fake = installerFake({})
    const host = hostFake({
      readiness: { ...READY, agents: { 'claude-code': 'missing', 'codex': 'found' } },
      recommend: { plugins: [{ name: '@scope/claude-only', connections: ['agent:claude-code'], source: 'installed' }], registry: 'not-asked' },
    })
    render(<PluginsStep services={stepServices({ bundles: fake.installer, plugins: ['@scope/claude-only'] })} guide={guideOf(host.host)} />)
    await settle()
    expect(screen.queryAllByRole('heading', { level: 4 })).toEqual([])
    expect(screen.getByText(en['plugins.none'])).toBeTruthy()
    expect(fake.refresh).not.toHaveBeenCalledWith([])
  })

  it('shows every configured plugin in order when their connections cannot be read', async () => {
    const fake = installerFake(Object.fromEntries(plugins.map(name => [name, { state: 'available' as const }])))
    render(<PluginsStep services={stepServices({ bundles: fake.installer, plugins })} guide={guideOf(hostFake({ recommend: undefined }).host)} />)
    await settle()
    expect(screen.getByText(en['plugins.unread'])).toBeTruthy()
    expect(screen.getAllByRole('heading', { level: 4 }).map(each => each.textContent)).toEqual(['Codex quota', 'Any', 'Claude only', 'Unread'])
  })

  it('never leaves blank cards when the plugin manager is slow: after a wait it names the plugins and offers Try again', async () => {
    vi.useFakeTimers()
    try {
      const fake = installerFake(Object.fromEntries(plugins.map(name => [name, { state: 'checking' as const }])))
      render(<PluginsStep services={stepServices({ bundles: fake.installer, plugins })} guide={guideOf(hostFake({ recommend: undefined }).host)} />)
      await act(async () => { await vi.advanceTimersByTimeAsync(7000) })
      expect(screen.queryByText(en['plugins.slow'])).toBeNull()
      expect(screen.queryAllByRole('heading', { level: 4 })).toEqual([])
      await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
      expect(screen.getByText(en['plugins.slow'])).toBeTruthy()
      expect(screen.getAllByRole('heading', { level: 4 })).toHaveLength(plugins.length)
      fake.refresh.mockClear()
      await click(screen.getByRole('button', { name: en['bundle.retry'] }))
      expect(fake.refresh).toHaveBeenCalledWith(plugins)
    } finally {
      vi.useRealTimers()
    }
  })

  it('names a connection as the person knows it', () => {
    const { t } = stepServices()
    const providers = new Map([['deepseek-official', 'DeepSeek']])
    expect(['agent:claude-code', 'agent:codex', 'tool:tailscale', 'provider:deepseek-official', 'provider:other', 'tool:other'].map(id => connectionName(id, t, providers)))
      .toEqual(['Claude Code', 'Codex', 'Tailscale', 'DeepSeek', 'other', 'other'])
  })

  it('shows placeholder rows, never a package id, until a plugin\'s title is read', async () => {
    const fake = installerFake({ '@scope/codex-quota': { state: 'checking' } }, { 'delorun-cost-meter': { state: 'checking' } })
    render(<PluginsStep services={stepServices({ bundles: fake.installer, plugins: ['@scope/codex-quota', '@scope/any'], optionalRows: ['delorun-cost-meter'] })} guide={guideOf(hostFake({ recommend: undefined }).host)} />)
    await settle()
    expect(screen.queryAllByRole('heading', { level: 4 })).toEqual([])
    expect(screen.queryByText(/codex|delorun-cost-meter|Codex quota/i)).toBeNull()
    expect(document.querySelectorAll('[aria-hidden="true"]:empty, li[aria-hidden="true"]').length).toBeGreaterThanOrEqual(3)
  })

  it('says the computer-use driver pack is experimental and controls the desktop before it is downloaded', async () => {
    const name = '@delorun/bundle-computer-use-driver'
    const fake = installerFake({ [name]: { state: 'available' } })
    render(<PluginsStep services={stepServices({ bundles: fake.installer, plugins: [name] })} guide={guideOf(hostFake({ recommend: undefined }).host)} />)
    await settle()
    expect(screen.getAllByRole('heading', { level: 4 }).map(each => each.textContent)).toEqual([en['plugins.pack.computerUseDriver.title']])
    expect(screen.getByText(en['plugins.pack.computerUseDriver.description'])).toBeTruthy()
    expect(en['plugins.pack.computerUseDriver.description']).toMatch(/^Experimental\..*control the windows on this computer's desktop/u)
    expect(zh['plugins.pack.computerUseDriver.description']).toMatch(/^实验性功能。.*控制这台电脑桌面上的窗口/u)
    expect(fake.install).not.toHaveBeenCalled()
  })

  it('leaves the Browser pack to its own step, and gives the packs near Claude Code, Codex and a browser the guide\'s own titles', async () => {
    const plugins = ['@delorun/bundle-browser', '@delorun/bundle-agent-hooks', '@delorun/bundle-external-agents', '@delorun/bundle-real-browser']
    // The plugin manager's own titles lose to the guide's words for Delorun's packs.
    const fake = installerFake(Object.fromEntries(plugins.map(name => [name, { state: 'available' as const, title: 'Package title' }])))
    render(<PluginsStep services={stepServices({ bundles: fake.installer, plugins })} guide={guideOf(hostFake({ recommend: undefined }).host)} />)
    await settle()
    expect(screen.getAllByRole('heading', { level: 4 }).map(each => each.textContent)).toEqual([
      en['plugins.pack.agentHooks.title'], en['plugins.pack.externalAgents.title'], en['plugins.pack.realBrowser.title'],
    ])
    expect(new Set([en['plugins.pack.agentHooks.title'], en['plugins.pack.externalAgents.title'], en['agents.claude.title'], en['agents.codex.title']]).size).toBe(4)
  })

  it('names a plugin whose title is not known yet in words, never by its package id', () => {
    expect(['@scope/codex-quota', '@deepseek-ai/dsh-session-search', 'plain', '@delorun/bundle-browser'].map(readableName)).toEqual(['Codex quota', 'Dsh session search', 'Plain', 'Browser'])
  })
})

describe('the phone access step', () => {
  const reachWith = (tailscale: TailscaleReadiness | undefined) => hostFake({ readiness: tailscale === undefined ? undefined : { ...READY, tailscale } }).host
  const checks = () => screen.queryAllByRole('listitem').filter(each => each.hasAttribute('data-state'))
  const states = () => checks().map(each => each.getAttribute('data-state'))

  it('says how phone access is set up, in three numbered steps, and what a phone can do once it is in', () => {
    render(<ReachStep services={stepServices()} guide={guideOf(reachWith(undefined))} />)
    const how = screen.getByRole('region', { name: en['reach.how'] })
    expect(within(how).getByRole('list').tagName).toBe('OL')
    expect(within(how).getAllByRole('listitem').map(each => each.textContent)).toEqual([1, 2, 3].map(n => `${String(n)}${en[`reach.how.${String(n)}.title` as 'reach.how.1.title']}${en[`reach.how.${String(n)}.text` as 'reach.how.1.text']}`))
    const uses = screen.getByRole('region', { name: en['reach.uses'] })
    expect(within(uses).getAllByRole('listitem').map(each => each.textContent)).toEqual([1, 2, 3].map(n => `${en[`reach.uses.${String(n)}.title` as 'reach.uses.1.title']}${en[`reach.uses.${String(n)}.text` as 'reach.uses.1.text']}`))
  })

  it.each<readonly [TailscaleReadiness['state'], readonly string[], string | undefined]>([
    ['not-installed', ['todo', 'waiting', 'waiting', 'waiting'], undefined],
    ['signed-out', ['done', 'todo', 'waiting', 'waiting'], 'tailscale up'],
    ['https-off', ['done', 'done', 'todo', 'waiting'], undefined],
    ['needs-operator', ['done', 'done', 'done', 'todo'], TAILSCALE_OPERATOR_COMMAND],
  ])('marks the checks up to %s done, says how to fix that one, and keeps the rest waiting', async (state, marks, fix) => {
    render(<ReachStep services={stepServices()} guide={guideOf(reachWith({ state } as TailscaleReadiness))} />)
    expect(screen.getByText(en['reach.checking'])).toBeTruthy()
    await settle()
    expect(states()).toEqual(marks)
    const todo = document.querySelector('[data-state="todo"]') as HTMLElement
    expect(todo.textContent).toContain(en['reach.state.todo'])
    if (fix !== undefined) expect(within(todo).getByText(fix).tagName).toBe('CODE')
    expect(screen.queryByText(/Your phone opens/)).toBeNull()
  })

  it('reads as one sentence and one command, with the details under More', async () => {
    render(<ReachStep services={stepServices()} guide={guideOf(reachWith({ state: 'not-installed' } as TailscaleReadiness))} />)
    await settle()
    const more = document.querySelector('details') as HTMLDetailsElement
    expect(more.open).toBe(false)
    expect(more.querySelector('summary')?.textContent).toBe(en['reach.more'])
    expect(screen.getByText(REACH_COMMAND).closest('details')).toBeNull()
    expect(en['reach.lead']).not.toMatch(/\b(reach|tailnet|serve|PIN mode)\b/i)
  })

  // Removing the Phone powers block from the step brings back a choice for a level that no longer exists.
  it('offers no Phone powers choice', async () => {
    render(<ReachStep services={stepServices()} guide={guideOf(reachWith({ state: 'not-installed' } as TailscaleReadiness))} />)
    await settle()
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(document.body.textContent).not.toMatch(/Phone powers/i)
  })

  it('leaves the PIN to its own step instead of offering it under More', async () => {
    render(<ReachStep services={stepServices()} guide={guideOf(reachWith({ state: 'not-installed' } as TailscaleReadiness))} />)
    await settle()
    expect(screen.queryByText(/PIN/)).toBeNull()
  })

  it('marks every check done and names the address the phone opens once Tailscale is ready', async () => {
    render(<ReachStep services={stepServices()} guide={guideOf(reachWith(READY.tailscale))} />)
    await settle()
    expect(states()).toEqual(['done', 'done', 'done', 'done'])
    expect(screen.getByText('Your phone opens https://box.example.ts.net.')).toBeTruthy()
  })

  it.each<readonly [string, TailscaleReadiness | undefined]>([
    ['the computer could not be read', undefined],
    ['Tailscale could not be read', { state: 'unknown' }],
  ])('says so when %s and still gives the commands', async (_, tailscale) => {
    render(<ReachStep services={stepServices()} guide={guideOf(reachWith(tailscale))} />)
    await settle()
    expect(screen.getByText(en['reach.unread'])).toBeTruthy()
    expect(checks()).toHaveLength(0)
    expect(screen.getByText(REACH_COMMAND).tagName).toBe('CODE')
    expect(screen.getByText(APPROVE_COMMAND).tagName).toBe('CODE')
  })

  it('names the commands run at this computer, that a phone is approved there and the phone confirms the rest, and no relay', async () => {
    render(<ReachStep services={stepServices()} guide={guideOf()} />)
    await settle()
    expect([REACH_COMMAND, APPROVE_COMMAND]).toEqual(['delorun reach on tailscale', 'delorun devices approve'])
    expect(document.body.textContent).toContain('A phone is approved only at this computer, and the sensitive things it does are confirmed on the phone itself.')
    for (const [key, text] of Object.entries(en)) if (key.startsWith('reach.')) expect(text).not.toMatch(/relay|中继/i)
  })
})

describe('the ready step', () => {
  const ready = (guide: Guide, options: { readonly target?: StartTarget; readonly reach?: 'absent' | 'set-up' | 'off'; readonly services?: StepServices; readonly first?: boolean } = {}) =>
    render(<ReadyStep services={options.services ?? stepServices()} guide={guide} reach={options.reach ?? 'off'} target={options.target ?? { kind: 'checking' }} keepCurrent={false} first={options.first ?? false} />)
  // A value's own text; the workspace's path sits in a span under its folder name.
  const rows = () => [...document.querySelectorAll('dt')].map(each => [each.textContent, each.nextElementSibling?.firstChild?.textContent, each.nextElementSibling?.getAttribute('data-tone') ?? undefined])
  const workspacePath = () => document.querySelector('dd > span')?.textContent

  it('shows the default workspace as a plain value when the Workspace step was skipped', async () => {
    ready(guideOf(), { target: { kind: 'default', workspaceId: DEFAULT_WORKSPACE, path: DEFAULT_PATH } })
    await settle()
    expect(rows().find(row => row[0] === 'Workspace')).toEqual(['Workspace', 'Delorun', undefined])
    expect(workspacePath()).toBe(DEFAULT_PATH)
  })

  it('lists what the guide set and the starting prompts that fit the chosen folder', async () => {
    const [claude] = AGENT_BUNDLES
    const fake = installerFake({ [claude.name]: { state: 'installed' }, '@scope/a': { state: 'restart' }, '@scope/b': { state: 'available' } })
    const guide = guideOf()
    guide.chooseWorkspace({ kind: 'added', workspaceId: 'workspace-2' as WorkspaceId, path: '/home/person/app', folder: 'code' })
    ready(guide, { reach: 'set-up', services: stepServices({ bundles: fake.installer, plugins: ['@scope/a', '@scope/b'] }) })
    await settle()
    expect(rows()).toEqual([
      ['Model', 'DeepSeek', undefined],
      ['Look', 'Soft · System', undefined],
      ['Agents', 'Claude Code', undefined],
      ['Plugins', '1 added', undefined],
      ['Phone access', 'On', undefined],
      ['Workspace', 'app', undefined],
    ])
    expect(workspacePath()).toBe('/home/person/app')
    expect(screen.getByText(en['ready.ideas'])).toBeTruthy()
    expect(screen.getAllByRole('listitem').map(each => each.textContent)).toEqual(['code.1', 'code.2', 'code.3'].map(key => `${en[`starter.${key}.label` as 'starter.code.1.label']}${en[`starter.${key}.prompt` as 'starter.code.1.prompt']}${en.copy}`))
  })

  it('says what is missing: no working key, no workspace, and leaves phone access out where the home has no reach', async () => {
    const theme = liveForm<ThemeSettings>({ ...THEME, palette: 'grove' })
    ready(guideOf(hostFake({ keys: { providers: [{ provider: 'deepseek-official', name: 'DeepSeek', result: 'rejected' }] } }).host), {
      reach: 'absent', target: { kind: 'none' }, services: stepServices({ look: { settings: theme.form, useStockLook: () => Promise.resolve(true) } }),
    })
    await settle()
    expect(rows()).toEqual([
      ['Model', en['ready.model.none'], 'attention'],
      ['Look', 'Grove · System', undefined],
      ['Agents', en['ready.none'], undefined],
      ['Plugins', en['ready.none'], undefined],
      ['Workspace', en['ready.workspace.none'], 'attention'],
    ])
    expect(screen.queryByText(en['ready.ideas'])).toBeNull()
  })

  it('lists only the model and the workspace on a first open, and points to Settings in one sentence', async () => {
    const [claude] = AGENT_BUNDLES
    ready(guideOf(), {
      first: true, reach: 'set-up', target: { kind: 'default', workspaceId: DEFAULT_WORKSPACE, path: DEFAULT_PATH },
      services: stepServices({ bundles: installerFake({ [claude.name]: { state: 'installed' } }).installer }),
    })
    await settle()
    expect(rows()).toEqual([['Model', 'DeepSeek', undefined], ['Workspace', 'Delorun', undefined]])
    expect(screen.getByText(en['ready.more'])).toBeTruthy()
    expect(screen.queryByText(en['start.later'])).toBeNull()
    expect(en['ready.more']).toBe('Look, agents, plugins and phone access are in Settings. Settings → General → Getting started opens the full guide.')
  })

  it('keeps the full checklist and the Getting started line when the guide is opened from Settings', async () => {
    ready(guideOf(), { reach: 'set-up', target: { kind: 'other' } })
    await settle()
    expect(rows().map(row => row[0])).toEqual(['Model', 'Look', 'Agents', 'Plugins', 'Phone access', 'Workspace'])
    expect(screen.getByText(en['start.later'])).toBeTruthy()
    expect(screen.queryByText(en['ready.more'])).toBeNull()
  })

  it('names the last-used workspace with the general prompts, and phone access as off', async () => {
    ready(guideOf(hostFake({ keys: undefined }).host), { target: { kind: 'other' } })
    await settle()
    expect(rows().slice(-2)).toEqual([['Phone access', 'Not set up', undefined], ['Workspace', en['ready.workspace.last'], undefined]])
    expect(screen.getAllByRole('listitem').map(each => each.textContent)).toEqual([1, 2, 3].map(n => `${en[`starter.general.${String(n)}.label` as 'starter.general.1.label']}${en[`starter.general.${String(n)}.prompt` as 'starter.general.1.prompt']}${en.copy}`))
  })

  it('copies an idea to the clipboard and writes nothing into a message box', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    ready(guideOf(hostFake({ keys: undefined }).host), { target: { kind: 'other' } })
    await settle()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: `Copy the idea “${en['starter.general.1.label']}”` })) })
    expect(writeText).toHaveBeenCalledExactlyOnceWith(en['starter.general.1.prompt'])
    expect(screen.getByText(en['copy.done'])).toBeTruthy()
    vi.unstubAllGlobals()
  })

  it('names the default look while the theme settings are still loading', async () => {
    ready(guideOf(), { services: stepServices({ look: { settings: liveForm<ThemeSettings>(undefined).form, useStockLook: () => Promise.resolve(true) } }) })
    await settle()
    expect(rows()[1]).toEqual(['Look', 'Soft · System', undefined])
  })

  it('shows the default workspace once the dialog chose it', async () => {
    const guide = guideOf()
    guide.chooseWorkspace({ kind: 'default', workspaceId: DEFAULT_WORKSPACE, path: DEFAULT_PATH })
    ready(guide, { target: { kind: 'default', workspaceId: DEFAULT_WORKSPACE, path: DEFAULT_PATH } })
    await settle()
    expect(rows().at(-1)).toEqual(['Workspace', 'Delorun', undefined])
    expect(KEYS.providers).toHaveLength(1)
  })
})

describe('a set of chips', () => {
  const group = (name: string) => screen.getByRole('radiogroup', { name })
  const radios = (name: string) => within(group(name)).getAllByRole('radio')
  const key = async (element: HTMLElement, name: string) => { await act(async () => { fireEvent.keyDown(element, { key: name }) }) }

  it('is one tab stop, on the chosen chip', () => {
    look(stepServices())
    for (const name of ['Mode', 'Theme']) {
      const stops = radios(name).filter(each => each.tabIndex === 0)
      expect(stops).toHaveLength(1)
      expect(stops[0]?.getAttribute('aria-checked')).toBe('true')
    }
  })

  it('puts the tab stop on the first chip when none is chosen', () => {
    const store = createSnapshotStore({ ...LOCALES, active: 'fr' })
    render(<WelcomeStep services={stepServices({ language: { getSnapshot: store.getSnapshot, subscribe: store.subscribe, setLocale: vi.fn() } })} guide={guideOf()} notice={undefined} />)
    expect(radios(en['welcome.language']).map(each => each.tabIndex)).toEqual([0, -1])
  })

  it('moves to the next and previous chip with the arrow keys, wrapping, and chooses it', async () => {
    const { face, set } = schemeFace('light')
    look(stepServices({ scheme: face }))
    const [light, dark, system] = radios('Mode') as [HTMLElement, HTMLElement, HTMLElement]
    light.focus()
    await key(light, 'ArrowRight')
    expect(document.activeElement).toBe(dark)
    expect(set).toHaveBeenLastCalledWith('dark')
    await key(dark, 'ArrowDown')
    expect(set).toHaveBeenLastCalledWith('system')
    await key(system, 'ArrowDown')
    expect(document.activeElement).toBe(light)
    expect(set).toHaveBeenLastCalledWith('light')
    await key(light, 'ArrowLeft')
    expect(document.activeElement).toBe(system)
    await key(system, 'ArrowUp')
    expect(document.activeElement).toBe(dark)
    expect(dark.tabIndex).toBe(0)
    expect([light.tabIndex, system.tabIndex]).toEqual([-1, -1])
  })

  it('moves to the first and last chip with Home and End, and leaves a chosen chip as it is', async () => {
    const { face, set } = schemeFace('light')
    look(stepServices({ scheme: face }))
    const [light, , system] = radios('Mode') as [HTMLElement, HTMLElement, HTMLElement]
    await key(light, 'End')
    expect(document.activeElement).toBe(system)
    expect(set).toHaveBeenCalledExactlyOnceWith('system')
    await key(system, 'Home')
    expect(document.activeElement).toBe(light)
    expect(set).toHaveBeenLastCalledWith('light')
    set.mockClear()
    await key(light, 'Home')
    expect(set).not.toHaveBeenCalled()
  })

  it('disables a set whose chips cannot be chosen', () => {
    const waiting = liveForm<ThemeSettings>(undefined, { writable: false })
    look(stepServices({ look: { settings: waiting.form, useStockLook: () => Promise.resolve(true) } }))
    for (const name of ['Theme']) expect(radios(name).every(each => (each as HTMLButtonElement).disabled)).toBe(true)
    expect(radios('Mode').map(each => each.tabIndex)).toEqual([-1, -1, 0])
  })

  it('ignores other keys, and keys that do not come from a chip', async () => {
    const { face, set } = schemeFace('light')
    look(stepServices({ scheme: face }))
    const [light] = radios('Mode') as [HTMLElement]
    await key(light, 'a')
    await key(group('Mode'), 'ArrowRight')
    expect(set).not.toHaveBeenCalled()
  })
})

describe('what the guide shows after the audit', () => {
  it('offers only the languages the guide has copy for, plus the active one', () => {
    const locales = { active: 'en', revision: 1, locales: [{ id: 'en', label: 'English' }, { id: 'zh', label: '中文' }, { id: 'ja', label: '日本語' }] }
    const store = createSnapshotStore(locales)
    const face = { getSnapshot: store.getSnapshot, subscribe: store.subscribe, setLocale: vi.fn() }
    render(<WelcomeStep services={stepServices({ language: face })} guide={guideOf()} notice={undefined} />)
    expect(screen.getAllByRole('radio').map(each => each.textContent)).toEqual([`English${en['welcome.language.own']}`, `中文${zh['welcome.language.own']}`])
  })

  it('lets a path break only after a slash, keeping each folder name whole', () => {
    const { container } = render(<span><BreakablePath path="/tmp/polish2-home/work" /></span>)
    expect([...container.querySelectorAll('span > span > span')].map(each => each.textContent)).toEqual(['/', 'tmp/', 'polish2-home/', 'work'])
    expect(container.querySelectorAll('wbr')).toHaveLength(4)
  })

  it('keeps "sign-in" unbreakable and leaves other copy alone', () => {
    expect(keepSignInTogether('with its own sign-in.')).toBe('with its own sign\u2060-\u2060in.')
    expect(keepSignInTogether('Nothing to keep.')).toBe('Nothing to keep.')
  })

  it('reads one key state on Ready and Models: a found key the test could not reach is named, not called missing', async () => {
    render(<ReadyStep services={stepServices()} guide={guideOf(hostFake({ keys: { providers: [{ provider: 'deepseek-official', name: 'DeepSeek', result: 'unreachable' }] } }).host)} reach="absent" target={{ kind: 'none' }} keepCurrent={false} first={false} />)
    await settle()
    expect(screen.getByText('DeepSeek (key found, not checked)')).toBeTruthy()
  })

  it('says Tailscale is set up and remote access is off, and keeps the command that turns it on, when every Tailscale check passes', async () => {
    render(<ReachStep services={stepServices()} guide={guideOf(hostFake({ readiness: { ...READY, tailscale: { state: 'ready', dnsName: 'box.example.ts.net' } } }).host)} />)
    await settle()
    expect(screen.getByText(en['reach.tailscaleReady'])).toBeTruthy()
    expect(screen.queryByText(en['reach.lead'])).toBeNull()
    expect(screen.getByText(REACH_COMMAND)).toBeTruthy()
  })
})
