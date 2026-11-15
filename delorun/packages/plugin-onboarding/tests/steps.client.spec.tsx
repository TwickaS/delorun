// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_BUNDLES, AgentsStep } from '../src/client/steps/Agents.tsx'
import { LookStep } from '../src/client/steps/Look.tsx'
import { connectionName, PluginsStep, readableName } from '../src/client/steps/Plugins.tsx'
import { APPROVE_COMMAND, REACH_COMMAND, ReachStep } from '../src/client/steps/Reach.tsx'
import { ReadyStep } from '../src/client/steps/Ready.tsx'
import { WelcomeStep } from '../src/client/steps/Welcome.tsx'
import { CommandRow as Command } from '../src/client/ui/CommandRow.tsx'
import { createGuide, type Guide } from '../src/client/guide.ts'
import { en } from '../src/client/locales.ts'
import { ACCENT_PRESETS, PALETTE_CHOICES } from '../src/client/previews.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { TAILSCALE_OPERATOR_COMMAND } from '@delorun/contract-reach-providers'
import type { Readiness, TailscaleReadiness } from '../src/wire.ts'
import { DEFAULT_PATH, DEFAULT_WORKSPACE, hostFake, installerFake, KEYS, languageFace, liveForm, LOCALES, noticeFace, READY, schemeFace, stepServices, THEME } from './fixtures.client.ts'
import type { HostFace, StartTarget, StepServices } from '../src/client/types.ts'
import type { ThemeSettings } from '@delorun/plugin-theme'

afterEach(cleanup)

const click = async (element: HTMLElement) => { await act(async () => { fireEvent.click(element) }) }
const radio = (name: string | RegExp) => screen.getByRole('radio', { name })
const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }

/** A guide over a faked harness, its reads settled once the component renders. */
const guideOf = (host: HostFace = hostFake().host): Guide => createGuide(host)

/** Render the look step, whose guide is unused. */
const look = (services: StepServices) => render(<LookStep services={services} guide={guideOf()} />)

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
    expect(chips.map(each => each.textContent)).toEqual(['Soft', 'T3 Code', 'T3 Chat', 'Grove', 'Ocean', 'Ember', 'Iris'])
    expect(PALETTE_CHOICES).toHaveLength(chips.length)
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

  it('offers the accent presets with the Soft palette, writes the one chosen, and locks them with a note for a theme that brings its own', async () => {
    const services = stepServices()
    look(services)
    const group = screen.getByRole('radiogroup', { name: 'Accent' })
    expect(within(group).getAllByRole('radio').map(each => each.textContent)).toEqual(['Peach', 'Cobalt', 'Moss', 'Mono'])
    expect(ACCENT_PRESETS).toHaveLength(4)
    await click(radio('Peach'))
    await click(radio('Cobalt'))
    expect(services.look.settings.getSnapshot().value?.accent).toBe('cobalt')
    await click(radio('Grove'))
    expect((radio('Cobalt') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/Set by the theme/)).toBeTruthy()
  })

  it('starts from Soft and Peach until the theme settings arrive, and disables the choices it cannot save', () => {
    const waiting = liveForm<ThemeSettings>(undefined, { writable: false })
    look(stepServices({ look: { settings: waiting.form, useStockLook: () => Promise.resolve(true) } }))
    expect(radio('Soft').getAttribute('aria-checked')).toBe('true')
    expect(radio('Peach').getAttribute('aria-checked')).toBe('true')
    expect([radio('Iris'), radio('Cobalt'), screen.getByRole('button', { name: 'Stock' })].every(each => (each as HTMLButtonElement).disabled)).toBe(true)
    expect((radio('Dark') as HTMLButtonElement).disabled).toBe(false)
  })

  it('offers the stock look as a quiet line, and switches only after the confirmation that says it closes the guide', async () => {
    const useStockLook = vi.fn(() => Promise.resolve(true))
    look(stepServices({ look: { settings: liveForm<ThemeSettings>(THEME).form, useStockLook } }))
    expect(screen.queryByRole('radiogroup', { name: en['look.studio'] })).toBeNull()
    expect(screen.getByText(en['look.stock.ask'], { exact: false })).toBeTruthy()
    await click(screen.getByRole('button', { name: 'Stock' }))
    expect(screen.getByText(/turns Delorun's studio additions off and closes this guide/)).toBeTruthy()
    expect(useStockLook).not.toHaveBeenCalled()
    await click(screen.getByRole('button', { name: en['look.stock.no'] }))
    expect(useStockLook).not.toHaveBeenCalled()
    await click(screen.getByRole('button', { name: 'Stock' }))
    await click(screen.getByRole('button', { name: en['look.stock.yes'] }))
    expect(useStockLook).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows a small chat drawn in the chosen look beside the choices', () => {
    look(stepServices())
    const preview = screen.getByRole('img', { name: en['look.preview'] })
    expect(preview.textContent).toContain(en['look.preview.ask'])
    expect(preview.textContent).toContain(en['look.preview.tool'])
    expect(preview.textContent).toContain(en['look.preview.box'])
  })

  it.each<readonly [string, () => Promise<boolean>]>([
    ['refuses the write', () => Promise.resolve(false)],
    ['cannot be reached', () => Promise.reject(new Error('transport'))],
  ])('shows a failure and keeps the choice open when the host %s', async (_, write) => {
    look(stepServices({ look: { settings: liveForm<ThemeSettings>(THEME).form, useStockLook: write } }))
    await click(screen.getByRole('button', { name: 'Stock' }))
    await click(screen.getByRole('button', { name: en['look.stock.yes'] }))
    expect(screen.getByRole('alert').textContent).toBe(en.saveFailed)
  })

  it.each<readonly [string, boolean | 'reject', string]>([
    ['refuses a palette', false, 'Iris'],
    ['cannot be reached for a palette', 'reject', 'Iris'],
    ['refuses an accent', false, 'Cobalt'],
    ['cannot be reached for an accent', 'reject', 'Cobalt'],
  ])('shows a failure when the host %s', async (_, result, choice) => {
    const form = liveForm<ThemeSettings>(THEME, { result })
    look(stepServices({ look: { settings: form.form, useStockLook: () => Promise.resolve(true) } }))
    await click(radio(choice))
    expect(screen.getByRole('alert').textContent).toBe(en.saveFailed)
  })

  it('clears a failure on the next attempt', async () => {
    const form = liveForm<ThemeSettings>(THEME, { result: false })
    look(stepServices({ look: { settings: form.form, useStockLook: () => Promise.resolve(true) } }))
    await click(radio('Cobalt'))
    expect(screen.getByRole('alert')).toBeTruthy()
    form.set.mockImplementationOnce(() => Promise.resolve(true))
    await click(radio('Moss'))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('the welcome step', () => {
  it('lists the languages as chips and switches the interface language when one is chosen', async () => {
    const { face, setLocale } = languageFace()
    render(<WelcomeStep services={stepServices({ language: face })} guide={guideOf()} notice={undefined} />)
    const group = screen.getByRole('radiogroup', { name: en['welcome.language'] })
    expect(within(group).getAllByRole('radio').map(each => [each.textContent, each.getAttribute('aria-checked')])).toEqual([['English', 'true'], ['中文', 'false']])
    await click(radio('中文'))
    expect(setLocale).toHaveBeenCalledWith('zh')
    expect(radio('中文').getAttribute('aria-checked')).toBe('true')
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

  it.each<readonly [string, 'checking' | 'installing' | 'failed' | 'unavailable']>([
    ['is being checked', 'checking'],
    ['is being added', 'installing'],
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

  it('asks before Continue drops an open Add confirmation: Add installs it, Don\'t add leaves it', async () => {
    const [claude, codex] = AGENT_BUNDLES
    const fake = installerFake({ [claude.name]: { state: 'available' }, [codex.name]: { state: 'available' } })
    const guide = guideOf()
    render(<AgentsStep services={stepServices({ bundles: fake.installer })} guide={guide} />)
    expect(await guide.passGates()).toBe(true)
    await click(screen.getByRole('button', { name: 'Add Claude Code' }))
    let go = true
    await act(async () => { go = await guide.passGates() })
    expect(go).toBe(false)
    const ask = screen.getByRole('alertdialog', { name: 'Add Claude Code first?' })
    expect(document.activeElement).toBe(ask)
    await click(within(ask).getByRole('button', { name: en['agents.ask.skip'] }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(fake.install).not.toHaveBeenCalled()
    expect(await guide.passGates()).toBe(true)
    await click(screen.getByRole('button', { name: 'Add Claude Code' }))
    await act(async () => { await guide.passGates() })
    await click(within(screen.getByRole('alertdialog')).getByRole('button', { name: en['agents.ask.add'] }))
    expect(fake.install).toHaveBeenCalledExactlyOnceWith(claude.name)
  })

  it('shows what adding an agent means after Add, and installs only on the confirming press', async () => {
    const [claude, codex] = AGENT_BUNDLES
    const fake = installerFake({ [claude.name]: { state: 'available' }, [codex.name]: { state: 'available' } })
    render(<AgentsStep services={stepServices({ bundles: fake.installer })} guide={guideOf()} />)
    const adds = screen.getAllByRole('button', { name: /^Add / })
    expect(adds.map(each => [each.getAttribute('aria-label'), each.textContent])).toEqual([['Add Claude Code', en['bundle.add']], ['Add Codex', en['bundle.add']]])
    await click(screen.getByRole('button', { name: 'Add Codex' }))
    expect(fake.install).not.toHaveBeenCalled()
    const confirm = screen.getByRole('group', { name: 'What adding Codex means' })
    expect(within(confirm).getAllByRole('listitem').map(each => each.textContent)).toEqual([
      en['agents.confirm.handoff'], en['agents.confirm.limits'], en['agents.confirm.outside'], en['agents.confirm.files'], en['agents.confirm.billing'],
    ])
    expect(confirm.textContent).toContain('Delorun asks here on this computer first')
    // The frame's CSS demotes Continue while an element marked data-confirming is open.
    expect(confirm.hasAttribute('data-confirming')).toBe(true)
    await click(within(confirm).getByRole('button', { name: en['chooser.cancel'] }))
    expect(screen.queryByRole('group')).toBeNull()
    expect(fake.install).not.toHaveBeenCalled()
    await click(screen.getByRole('button', { name: 'Add Codex' }))
    await click(within(screen.getByRole('group')).getByRole('button', { name: 'Add Codex' }))
    expect(fake.install).toHaveBeenCalledExactlyOnceWith(codex.name)
    expect(screen.queryByRole('group')).toBeNull()
  })

  it.each<readonly [string, 'checking' | 'installing' | 'installed' | 'restart' | 'unavailable' | 'failed', string]>([
    ['is being checked', 'checking', en['bundle.checking']],
    ['is being added', 'installing', en['bundle.adding']],
    ['is added', 'installed', en['bundle.added']],
    ['is added but waits for a restart', 'restart', en['bundle.restart']],
    ['is not included in the installation', 'unavailable', en['bundle.unavailable']],
    ['could not be added', 'failed', en['bundle.failed']],
  ])('shows the state of a bundle that %s and no Add button', (_, state, text) => {
    const [claude] = AGENT_BUNDLES
    const fake = installerFake({ [claude.name]: { state } })
    render(<AgentsStep services={stepServices({ bundles: fake.installer })} guide={guideOf()} />)
    expect(screen.getAllByText(text).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: /^Add/ })).toBeNull()
  })

  it('shows a bundle the installation does not include as a normal state with a way to Plugins, never as an error', async () => {
    const [claude, codex] = AGENT_BUNDLES
    const fake = installerFake({ [claude.name]: { state: 'unavailable' }, [codex.name]: { state: 'unavailable' } })
    render(<AgentsStep services={stepServices({ bundles: fake.installer })} guide={guideOf()} />)
    expect(screen.getAllByText(en['bundle.unavailable'])).toHaveLength(2)
    // No sign-in line beside "Not included": the two would read as a contradiction.
    await settle()
    expect(screen.queryByText(en['agents.claude.signIn.found'])).toBeNull()
    expect(screen.queryByText(en['agents.signIn.checking'])).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    const opens = screen.getAllByRole('button', { name: 'Open Plugins' })
    expect(opens).toHaveLength(2)
    await click(opens[0] as HTMLElement)
    expect(fake.openPlugins).toHaveBeenCalledOnce()
  })

  it('shows a bundle that failed to be added as an error under the card with a retry', async () => {
    const [claude] = AGENT_BUNDLES
    const fake = installerFake({ [claude.name]: { state: 'failed' } })
    render(<AgentsStep services={stepServices({ bundles: fake.installer })} guide={guideOf()} />)
    expect(within(screen.getByRole('alert')).getByText(en['bundle.failed'])).toBeTruthy()
    await click(screen.getByRole('button', { name: en['bundle.retry'] }))
    expect(screen.getByRole('group', { name: 'What adding Claude Code means' })).toBeTruthy()
    expect(fake.install).not.toHaveBeenCalled()
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

  it('names a plugin whose title is not known yet in words, never by its package id', () => {
    expect(['@scope/codex-quota', '@deepseek-ai/dsh-session-search', 'plain'].map(readableName)).toEqual(['Codex quota', 'Dsh session search', 'Plain'])
  })
})

describe('the phone access step', () => {
  const reachWith = (tailscale: TailscaleReadiness | undefined) => hostFake({ readiness: tailscale === undefined ? undefined : { ...READY, tailscale } }).host
  const states = () => screen.getAllByRole('listitem').map(each => each.getAttribute('data-state'))

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

  it('recommends PIN mode and says where to turn it on', async () => {
    render(<ReachStep services={stepServices()} guide={guideOf(reachWith({ state: 'not-installed' } as TailscaleReadiness))} />)
    await settle()
    expect(screen.getByText(en['reach.pin'])).toBeTruthy()
    expect(en['reach.pin']).toContain('Settings → PIN mode')
    expect(en['reach.pin']).toContain('delorun devices pin set')
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
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
    expect(screen.getByText(REACH_COMMAND).tagName).toBe('CODE')
    expect(screen.getByText(APPROVE_COMMAND).tagName).toBe('CODE')
  })

  it('names the commands run at this computer, what a phone session cannot do, and no relay', async () => {
    render(<ReachStep services={stepServices()} guide={guideOf()} />)
    await settle()
    expect([REACH_COMMAND, APPROVE_COMMAND]).toEqual(['delorun reach on tailscale', 'delorun devices approve'])
    expect(document.body.textContent).toContain('A phone session cannot grant full access or approve devices.')
    for (const [key, text] of Object.entries(en)) if (key.startsWith('reach.')) expect(text).not.toMatch(/relay|中继/i)
  })
})

describe('the ready step', () => {
  const ready = (guide: Guide, options: { readonly target?: StartTarget; readonly reach?: 'absent' | 'set-up' | 'off'; readonly services?: StepServices } = {}) =>
    render(<ReadyStep services={options.services ?? stepServices()} guide={guide} reach={options.reach ?? 'off'} target={options.target ?? { kind: 'checking' }} keepCurrent={false} />)
  const rows = () => [...document.querySelectorAll('dt')].map(each => [each.textContent, each.nextElementSibling?.textContent, each.nextElementSibling?.getAttribute('data-tone') ?? undefined])

  it('shows the default workspace as a plain value when the Workspace step was skipped', async () => {
    ready(guideOf(), { target: { kind: 'default', workspaceId: DEFAULT_WORKSPACE, path: DEFAULT_PATH } })
    await settle()
    expect(rows().find(row => row[0] === 'Workspace')).toEqual(['Workspace', DEFAULT_PATH, undefined])
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
      ['Look', 'Soft · Peach · System', undefined],
      ['Agents', 'Claude Code', undefined],
      ['Plugins', '1 added', undefined],
      ['Phone access', 'On', undefined],
      ['Workspace', '/home/person/app', undefined],
    ])
    expect(screen.getAllByRole('listitem').map(each => each.textContent)).toEqual([en['starter.code.1.label'], en['starter.code.2.label'], en['starter.code.3.label']])
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
    expect(screen.queryByText(en['ready.starters'])).toBeNull()
  })

  it('names the last-used workspace with the general prompts, and phone access as off', async () => {
    ready(guideOf(hostFake({ keys: undefined }).host), { target: { kind: 'other' } })
    await settle()
    expect(rows().slice(-2)).toEqual([['Phone access', 'Not set up', undefined], ['Workspace', en['ready.workspace.last'], undefined]])
    expect(screen.getAllByRole('listitem').map(each => each.textContent)).toEqual([en['starter.general.1.label'], en['starter.general.2.label'], en['starter.general.3.label']])
  })

  it('names the default look while the theme settings are still loading', async () => {
    ready(guideOf(), { services: stepServices({ look: { settings: liveForm<ThemeSettings>(undefined).form, useStockLook: () => Promise.resolve(true) } }) })
    await settle()
    expect(rows()[1]).toEqual(['Look', 'Soft · Peach · System', undefined])
  })

  it('shows the default workspace once the dialog chose it', async () => {
    const guide = guideOf()
    guide.chooseWorkspace({ kind: 'default', workspaceId: DEFAULT_WORKSPACE, path: DEFAULT_PATH })
    ready(guide, { target: { kind: 'default', workspaceId: DEFAULT_WORKSPACE, path: DEFAULT_PATH } })
    await settle()
    expect(rows().at(-1)).toEqual(['Workspace', DEFAULT_PATH, undefined])
    expect(KEYS.providers).toHaveLength(1)
  })
})

describe('a set of chips', () => {
  const group = (name: string) => screen.getByRole('radiogroup', { name })
  const radios = (name: string) => within(group(name)).getAllByRole('radio')
  const key = async (element: HTMLElement, name: string) => { await act(async () => { fireEvent.keyDown(element, { key: name }) }) }

  it('is one tab stop, on the chosen chip', () => {
    look(stepServices())
    for (const name of ['Mode', 'Theme', 'Accent']) {
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
    for (const name of ['Theme', 'Accent']) expect(radios(name).every(each => (each as HTMLButtonElement).disabled)).toBe(true)
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
